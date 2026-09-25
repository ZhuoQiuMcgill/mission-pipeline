# Changelog

All notable changes to mission-pipeline are documented here. The plugin version,
this file, and the git tag move together — nothing reaches installed users
without a release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [Unreleased]

Runtime defects a downstream mission relayed after 2.1.0. No schema change and no new record
shape; `tests/m24_field_repairs.py` holds one regression test class per fix.

### Fixed
- **A plan re-record keeps every disposition.** `plan.record` kept only an existing
  obligation's `status`, so a deferred or cancelled obligation lost `grant`, `domain`,
  `deferred_owner` and `reason_blob` (and a met one its `evidence`), and `mission.close` then
  failed with an uncaught `KeyError: 'grant'`. The re-record now restates only the PM's text.
  A row already stripped by 2.1.0 refuses `DEFERRAL_INCOMPLETE` at close, naming the
  obligation; submitting the same `obligation.defer` or `obligation.cancel` again repairs it.
- **A task that has not started no longer blocks every bundle.** `bundle.record` refused
  `INPUT_INCOMPLETE` while any task of the mission declared an output without a delivery,
  including a later wave's task not yet admitted, so the bundle an earlier wave's aggregate
  cell needed could not be built. A declared output now needs its snapshot once its task has
  an admission of its current digest or any recorded run, and the refusal names the `task`.
  Because an admission is not in the bundle's delivery digest, `calibration.record` (except
  an INPUT_INCOMPLETE verdict) and `mission.close` recheck the same rule, so a task admitted
  after the bundle is still held to its outputs.
- **A decision naming another domain's task is refused.** `decision.record` accepted `tasks`
  whose domain differed from the decision's, and `decision_applies` then never applied it, so
  the PM held a record that authorized nothing. It now refuses `DECISION_DOMAIN_MISMATCH` with
  the `task`, its `task_domain` and the `decision_domain`, including for the tasks a revision
  inherits. Nothing in the runtime applies a decision across domains.
- **The `work.write` size limit is stated.** A file over 8 MiB was refused `INVALID_INPUT`
  ("exceeds the tool size limit") with the limit written nowhere. The limit is unchanged; it is
  now documented in `runtime-v4.md`, SKILL.md and the Constructor role, and the refusal names
  it and the file's size, with `limit`, `size` and `path` fields.
- **`query task` says whether a task is admitted and accepted.** The stored `status` of a task
  is its record status (`NOT_ADMITTED` until `task.replace` sets `REPLACED`), so the query
  printed `NOT_ADMITTED` for admitted and accepted tasks. The stored rows and the ledger are
  unchanged, and their digests still serve `revises`. A task query now adds a `derived` map
  keyed by task id, with `admission` (ADMITTED, STALE or NOT_ADMITTED) and `admission_id`,
  `acceptance` (ACCEPTED, STALE or NOT_ACCEPTED) and `acceptance_report`, plus a `note` saying
  what the stored status means. Nothing derived is stored.
- **A requirement id is listed once.** `requirement.record` appended its id to
  `task.required_runs` even when the task spec already listed it, leaving rows such as
  `["r-fig", "r-rep", "r-fig", "r-rep"]` and changing the task digest. A listed id is no longer
  appended, so that task row and its digest are unchanged; an unlisted id is appended once, as
  before. `task.record` still stores the list the PM sends, so a row already doubled is repaired
  by the next task revision that lists each id once.

## [2.1.0] — 2026-09-13

The usability release. 2.0.0 shipped an engine that was correct and, in the field, unusable.
Three ordinary `task.record` revisions while a case was open exhausted the rebase budget, and
every one of the nine recovery actions was then refused, so the mission could never close. The
twelve-call correction budget was per mission rather than per case, which made the thirteenth
case terminal. Screening and contest jobs expired after 300 seconds while local subagents
routinely take longer, `job.resume` needed a prior `jobs.expire` and misreported
`BUDGET_EXHAUSTED`, and after two resumes only dismissal remained. A hand-written
`run.begin`/`run.finish` submitted with `--actor controller` was recorded as controlled
execution and closed a mission with no process running. And the manual told nobody how to
operate any of it: 48 lines of SKILL.md, role files of seven to nine lines, no worked example
anywhere, and the only two manual calibration triggers undocumented. No schema change, no new
record shape, and existing 2.0 ledgers keep working. Rationale record:
`docs/design/DesignDoc_UsableRuntime_2.1_2026-09-13_v01.md`.

### Fixed
- **Rebase exhaustion no longer deadlocks a mission.** A third changed-head rebase closes the
  current case with `status: "TARGET_REPLACED"`, releases its barrier, deactivates its permits,
  supersedes any pending contest, and opens a successor case carrying the same mission, lineage,
  scope, target, counterexample, audit stance and repair count, with a fresh screening job.
  `review.rebase` returns `{"case": <new>, "superseded": "<old id>"}`.
- **The correction budget is per case.** `issue.screen` and `contest.decide` charge
  `<case id>:correction` with a cap of twelve. A mission-level `<lineage>:correction_total`
  counter is kept for reporting only and has no cap.
- **Review deadlines match the mode.** `project.configure` stores `review_deadline_seconds`,
  default 86400 local and 300 managed, minimum 60. Every screening, contest, supplement, resume
  and repair-compliance deadline uses it, and the UPHOLD repair window is `max(86400, value)`.
  `job.resume` accepts a PENDING or AWAIT_REPAIR job whose deadline has passed with no prior
  `jobs.expire`, keeps the two-resume cap, and reports `REVIEW_EXPIRED` with a `recovery` text
  when the cap is spent. `issue.screen` and `contest.decide` auto-resume an expired job inside
  the same transaction while a resume remains.
- **Dismissal is contestable and cannot pre-empt a contest.** `case.resolve` refuses
  `CONTEST_PENDING` while a contest is PENDING or INPUT_INCOMPLETE, and refuses
  `SCREENING_REQUIRED` for a DISMISSED outcome on a case with no `screening_author`.
  `case.contest` is open to pm and to every reporting role, on any case that is not replaced
  by a successor (`CASE_NOT_CONTESTABLE`) and not already final (`CONTEST_FINAL`), so a
  screening nobody reached in time can still go to an independent Stabilizer. `case.supplement`
  is also open to the Challenger, whose defence of a calibration accusation is exactly the one
  bounded supplement.
- **`controller` is the executor's internal identity.** The CLI, the field adapter and
  `bridge.serve_one` refuse actor role `controller` with `ROLE_FORBIDDEN`, including through
  `MP_ACTOR`. `runner.execute` and the managed broker still construct it in process, and
  `run.execute` itself is accepted only from a constructor, crititor or stabilizer seat, matching
  the managed role table.
- **A blanket PM decision no longer invalidates accepted work.** A decision that lists no
  `tasks` applies to a task only when that task has no ACCEPTED acceptance, current or
  superseded, created before the decision, so the rule stays stable across later rounds. All
  call sites use the same rule.
- **Files in `write_paths` are inside the product digest.** The calibration basis is task
  outputs plus task write paths plus required-run inputs, deduplicated and order-stable, so a
  helper rewritten after acceptance invalidates the cell that judged it. A write path that
  resolves inside private runtime state is skipped there; `work.write` refuses it anyway.
- **A dead run can be aborted from another session.** `run.abort` by pm or controller is allowed
  when the run is RUNNING and its lease has expired: `EXPIRED`, `satisfied: false`,
  `failure_code: "RUN_LEASE_EXPIRED"`. The owner-session path is unchanged.
- **Reports without a criteria table no longer bypass the check.** `report.record` refuses
  `CRITERIA_TABLE_REQUIRED` for a task with obligations when the document carries no criteria
  rows and the outcome is PASS or ACCEPTED, or COMPLETE with declared `criteria`. A development
  report that claims nothing is still recordable.
- **Closed outcome sets.** `audit.record.outcome` is PASS, FINDINGS or INPUT_INCOMPLETE, with
  PASS requiring zero findings; `close.review.outcome` and `plan.review.outcome` are PASS, FAIL
  or INPUT_INCOMPLETE and only PASS admits; `flag.raise` is limited to pm and the reporting
  roles and requires a root or intake; `mission.close` refuses `AUDIT_OUTCOME_REQUIRED` unless
  the audit outcome is PASS or FINDINGS. `project.configure` refuses `INVALID_REVIEW_DEADLINE`
  for a deadline that is not an integer of at least 60.
- **Plan review coverage reads obligation status.** `MISSING_PRODUCER` applies only to
  obligations still REQUIRED; one already MET (including through `legacy.accept`), deferred or
  cancelled needs no producing task, so a migrated mission plans its delivered and remaining work
  in one plan. The refusal now lists the `missing` obligations.
- **`delivery.record` cannot overwrite exported output.** It refuses `EXPORTED_OUTPUT` when the
  current delivery for that path was produced by a run.
- **Writer identity survives a machine rename.** `environment_id()` hashes the platform family
  and a token from `<config dir>/mission-pipeline/writer-id`, created with random hex on first
  use. The old hostname formula is retained as `legacy_environment_id()` and still accepted, and
  `maintenance recover` rewrites the owner record to the new identity.
- **Per-write cost.** `recover()` verifies only the journal tail past a `verified_seq` watermark
  held in `runtime_meta`; the full replay comparison stays in `doctor` and `rebuild`.
  `source_manifest` identity_version 3 takes git blob ids for clean tracked files and hashes
  only what `git status` reports as changed.

### Added
- **`obligation.cancel`**, pm with a `defer` grant or principal: `{obligation, grant, domain,
  owner, reason_blob}` sets `AUTHORIZED_CANCELLED` with the deferral fields plus `cancelled_by`.
  The status was read in five places and written nowhere.
- **Mid-mission migration continuity.** `adoption_plan` reports `acceptances`: every ACCEPTED
  verdict from a sealed GroupReport with its legacy mission, task key, artifact, sha256 and
  sequence. `legacy.adopt` adopts all VERIFIED overlays of the legacy mission when `artifacts`
  is omitted. New `legacy.accept` (pm) takes `{mission, obligation, legacy_artifact}` and sets
  the obligation MET with `evidence: "legacy:<artifact>"` and `assurance: "legacy-recorded"`;
  `mission.close` accepts such obligations and `bundle.record` includes the adopted overlays.
- **`maintenance takeover --confirm <project id>`**, principal only, claims a ledger whose owner
  environment is unreachable: new environment, epoch plus one, `takeover_from` recorded.
- **`references/walkthrough.md`**: one complete single-task mission through the public CLI,
  every request with its command line and the response fields that matter, then the 1.2 to 2.1
  mid-mission upgrade and the recovery commands.
- **Nine templates**: plan review, close review, issue screening, case resolution, contest
  decision, recovery permit, obligation deferral, obligation cancellation and legacy acceptance,
  with matching `template_catalog.EXAMPLES` entries.

### Changed
- **Honest execution labels.** A local run records `assurance="local-execution"` instead of
  `local-controlled-execution`. Every check that accepted the old label accepts both. The
  documentation states plainly that local execution freezes inputs, captures logs and outputs,
  and does not contain the process.
- **Seal conveniences in local mode.** `mp seal` sets `source_blob` only when the block does not
  name one and always records `document_blob`; validates list sections only for `report.record`;
  fills `contract_scope_digest`, `review_basis`, `admission`, `critique` and `revises` when they
  are absent; marks `reading_assurance="self-asserted"` when it filled a review field; and
  returns the request it submitted as `submitted_request` beside the result. Managed seal
  behaviour is unchanged.
- **Managed mode is documented as experimental.** The sandbox, broker and JSONL protocol are
  implemented and tested, but no model driver ships in this repository. README, SKILL.md,
  setup, substrate and the plugin descriptions say so.
- **The operating manual is back.** SKILL.md carries the cast with each seat's exact actions,
  the lifecycle in order with the request and the seal alternative per step, a refusal table
  with the fix for each code, closure, calibration, the counterexample path, fourteen numbered
  invariants and a plain statement of local versus managed assurance. Every role file states its
  inputs, its exact actions, the refusals it will meet and what it never does.
- **Hygiene.** `scripts/mp` becomes a launcher: `--bridge-stdio`, `MP_COMPAT_V3=1` to
  `legacy_v3.main`, otherwise the v4 CLI. The v3 guard and exit codes move into `legacy_v3.py`.

### Validation
- All 24 entry points (`m1_smoke` through `m23_continuity`, including the new
  `m22_usable_workflow` with 25 cases and `m23_continuity`) pass on Ubuntu WSL with Python
  3.14.4. Part 1 of the walkthrough was executed verbatim through the public CLI: 22 requests
  from `authority.record` to `mission.close`, root CLOSED, doctor clean, every run recorded as
  `local-execution`. The real 421-event 1.2 ledger migrates, adopts its open mission, accepts
  its six delivered obligations through `legacy.accept` and closes under v4 on a copy
  (`m23_continuity`). Measured: per-write cost flat at about 1.3 ms across 600 writes instead of
  growing from 2 ms to 12 ms; `source_manifest` on this repository 1.10 s to 0.51 s. Native
  Windows was not re-run in this release and must be re-run by the maintainer before field
  deployment.
- `tests/m9_migration.py` skips its real-data test with a message when the ignored corpus is
  absent and gains a synthetic fixture test that builds a v3 ledger under `MP_COMPAT_V3=1`,
  migrates it, adopts it, accepts a legacy obligation and closes under v4.
  `tests/m1_acceptance.py` exits 0 with `SKIP` when its corpus is absent, so the public suite
  runs on a clean checkout anywhere.

## [2.0.0] — 2026-09-09

The supervised-engine release. An independent Supervisor checks original intent, PM delegation, task admission and closure. Counterexamples, repair, independent review and current execution evidence now share one bounded workflow.

### Breaking changes
- The normal CLI uses structured requests and journal schema 4. Python 3.12+ and the complete skill directory, including `scripts/mp_runtime/`, are required; copying the old standalone script is insufficient.
- Managed execution requires a trusted JSONL controller and functioning Linux/WSL bubblewrap isolation. Native/local role labels remain self-asserted provenance.
- Legacy ledgers use explicit migration and adoption. Historical approvals remain history until requalified; migration preserves raw evidence and closed missions. Review `migrate --plan` before migration; publishing or installing this release does not migrate a live ledger.

### Added
- Independent Supervisor root/plan/closure review, scoped PM delegation, atomic mandatory-counterexample barriers and automatic independent Auditor contests.
- Current read receipts and bounded review rebasing; persistent independent reviewer lineage supports repair verification after a controller restart.
- Immutable input, output and log evidence; explicit execution predicates, mandatory closure bundles/audits and a supported read-only field adapter.
- Native PowerShell entry, UTF-8 JSON Windows/WSL bridge, persistent root mappings and explicit writer-environment handoff.

### Fixed
- Principal project contracts apply across missions, retain necessary original sources and cannot be weakened by candidate scope, omission or duplicate order. Explicit authorized retirement and delegated PM correction remain usable.
- Calibration and positive reports bind current code, products, runs and authority. Acceptance and consumption bookkeeping do not invalidate their own prerequisites.
- Current required attempts govern reuse and acceptance. New pending or failed attempts cannot borrow old PASS results. Actual timeouts and supported execution errors have durable terminal states, idempotent retrieval and bounded recovery.
- Multi-line acceptance parsing preserves partial outcomes; lifecycle, flags, scoped holds, crash recovery and legacy overlays preserve their distinct semantics.
- Windows/WSL special strings, encoding, CRLF identity, long paths, working directories, SQLite handles, concurrent ownership, interpreter/import origins, dependency repair and environment contamination are covered by actual execution tests.

### Validation
- All 22 test entry points passed on native Windows and Ubuntu WSL, alongside five independent ownership, CLI and 330-character-path probes.
- Independent Constructor/Crititor/Stabilizer review accepted implementation round 4 with no unresolved established blockers. Original runtime archives and historical task state were preserved.

## [1.2.0] — 2026-09-05

The closure-modes release. Two more days of field use (PR #4) found the pipeline
stalled for hours at a mission boundary with nothing blocking on substance: lint
re-checked 1.0.0-sealed documents against the 1.1 contract (163 false findings; the
close refuses on any); the harness's permission classifier blocked `mp mission claim`
and `mp mission close` — the two verbs that read like governance acts — while every
other verb had run for days unprompted; the engine's own text told the harness a human
belongs at the boundary; and the deployment's ratified delegation (its PM closes without
per-mission sign-off, the principal repudiates afterwards) was something the engine could
not read. The deployment's 29-item relay queue added the defect classes below. The
principal's ruling: closure modes, like a harness's permission modes, and a lifecycle
derived from documents like everything else. Rationale record:
`docs/design/DesignDoc_ClosureModes_2026-09-05_v01.md`.

### Added
- **Two closure modes**, declared once by the principal and recorded by the PM on their
  word (`mp config set closure sign-off|auto --quote …`, `mp init --closure …`; every
  declaration is an act in `mp acts`): **sign-off** — the principal accepts each mission
  in person (default, today's behaviour); **auto** — the PM closes when the gate
  conditions hold, the principal is never interrupted for procedure and repudiates item
  by item afterwards; a repudiation (`mp supersede mission:<name> --by principal`)
  reopens the mission. In both modes the substantive stops stay: a DRIFT halt, the
  SUSPICION ratchet, a Charter amendment. `mp config set audit on|off` decides whether a
  sealed Closure Audit is required to close.
- **The lifecycle is derived from documents.** Sealing a Charter v1 claims the mission
  (optional `branch:` / `cap:` header fields); sealing a **MissionClose** note
  (`templates/mission-close.md`) closes it — refused, naming every failing condition at
  once, while a flag is undisposed, the mission's lint has findings, the Charter is
  unsealed, the closing run is missing, drifted, or declared rather than measured, a
  required Closure Audit is absent, or the mode's own section (the principal's verbatim
  acceptance / the live delegating contract) is missing. No lifecycle verb remains for a
  classifier to single out: `mp gate close` is retired, `mp mission claim|close` are
  deprecated aliases.
- **Re-issue reconciliation.** Sealing a new version of a document supersedes every
  record the old version derived (evidence, verdicts, edges, relay) — except flags,
  which are reconciled by text: a matching bullet keeps its id and its disposition, a
  dropped one is retired, new text is a new flag. `- carried: flag:<id>` / `- carried:
  <text>` carries explicitly and never creates a flag. (Field: one 17-item residue list
  re-derived across three versions produced 52 flags and 77 undisposed items; the
  sentence "round 1's flags still stand" became a flag. `tests/m6_reissue.py`: 17 items,
  three versions, 17 flags.)
- **Runs say what they were:** `--result pass|fail|mixed`, `--expect fail` for a
  deliberate fail-before batch (never a passing anchor — a `met` row citing one is
  refused at seal), `--commit <sha>` to bind a run to the commit actually executed
  against when the tree has moved (a declared binding; never accepted as a closing
  run), script-path commands with the script's hash recorded, scope as part of a run's
  identity (a closing record of an identical output is no longer refused), and git's own
  tree id beside the content fingerprint. `mp run list|show`.
- **A full cell's Calibrator seals its accusation list** as a CalibrationVerdict whose
  verdict line begins `pending — Challenger and Arbiter convened`; its evidence and
  relay derive; the Arbiter's version supersedes it. A calibrator-only run is always
  ALIGNED.
- **Schema v3, `mp migrate` (v1 or v2 → v3) and `mp migrate --repair`**: re-stamps
  1.0.0 in-place-amended Charters so doctor stops reporting them, marks adopted
  prose-era artifacts as prose-only for lint, backfills one wave per mission that has
  specs but no wave; a pre-1.1 spec with no `touches-contract` header counts as `yes`
  for triggers. `--repair` is journaled, so doctor and rebuild still agree.
- **Permission note:** `/mission-pipeline:init` may, with the principal's one-sentence
  consent, allow the substrate command in the project's harness settings — the agent
  makes the edit; the principal only says yes or no.
- **Tests:** `tests/m5_closure.py` (both modes end to end, every refusal, a
  repudiation, and no lifecycle command in the journal), `tests/m6_reissue.py`,
  `tests/m7_runs.py`; m3/m4 extended. Eight gates.

### Changed
- **Invariant 9** now reads: *The principal closes the mission — in person (sign-off
  mode), or by standing delegation with item-by-item repudiation (auto mode). The mode
  is the principal's declaration in PROJECT.md; the PM never chooses it. Integration and
  reporting do not close a mission.* Invariant 10's "reaches sign-off" became "closes"
  (wording only). All other invariants are unchanged.
- The MissionClose seal lints its own mission only, and seal-parse only over 1.1+
  seals. Every "live records only" reading is literal: doctor's seal check, lint's
  disk and parse checks, `relay list|export`, worklist's edge scan skip superseded rows;
  superseded flags never count as undisposed.
- Roles and templates carry the modes: the Charter's signature line and the PM's close
  step render per mode; the Auditor's report is what stands in for the principal's
  presence in auto mode; Constructors never probe in a copied tree (an inherited
  virtualenv imports the unpatched source — field relay 13).

### Fixed
- **`mp lint` no longer asks a v1.0.0-sealed document for sections it never had.** The
  `seal-parse` rule re-checks a sealed document against the v1.1 section contract; on a
  migrated ledger every document sealed by the retired `artifact.seal` (a hash, never
  sections) came back as "no longer parses" — 110 findings on one mission, 163 across a
  deployment — and `mp gate close` refuses on any finding, so no mission that began
  before the migration could close mechanically. The rule now binds only documents
  sealed by the v1.1 derivation seal (`artifact.sealed`), read once from the journal;
  a v1.1 document that loses a required section is still caught (`tests/m4_migrate.py`).
- **`mp calib triggers` orders the post-compaction window by artifact id, not by the
  clock.** Seal timestamps have one-second resolution, so a spec sealed in the same
  second as the Integration Note it precedes landed "inside" the note's window and fired
  `post-compaction` — `tests/m3_dryrun.py` failed on main about one run in two. The
  window is now bounded by the closing note's `closed_in` artifact id (the artifact is
  the event), with the timestamp as the fallback for pre-`closed_in` rows.

## [1.1.0] — 2026-09-04

The derivation release. Three days of real use of 1.0.0 (5 missions, 77 tasks, 3296
field journal events, 5.25 MB of ledger prose) measured where the tokens went: **68 % of
all journal events were agents hand-copying facts from documents into the database** —
`evidence add` alone was 1088 calls and 73 % of everything typed into `mp`, and 0 of 8
sampled critiques still agreed with their own evidence rows. Meanwhile the real
invariants fired 0 times, because they were attached to optional ceremony (`round open`
was used on 36 of 76 tasks), the aggregate calibration's trend shape was dead (a metrics
bug dropped 12 of 77 tasks, so the Arbiter rightly refused every trend accusation), and
61 % of flags were about the ledger rather than the product. The defect was
double-entry: truth in two places, with the model as the courier. This release removes
the second entry. Rationale record:
`docs/design/DesignDoc_DerivationAndSupersession_2026-09-04_v01.md`.

### Added
- **`mp seal <path>` — the artifact is the event.** Agents write a document once and
  submit it with one call; the engine parses the `mp:header` block and the document's
  structured sections and derives every record: the artifact, evidence rows (the
  criteria table with its Type column), flags (Out-of-frame risk, Noticed but not
  fixed), verdicts, rounds, edges (`derives-from`), dispositions (an Integration Note's
  flag ledger), relay items, standing contracts (a Charter's prohibitions), wave
  closure. One journal event per artifact carries the full derived payload, so replay
  never re-reads a file. The M3 dry run measures the point: **2.00 journal events per
  artifact** against the field's 10.40, with no declaration verb in the journal.
- **Rules run at seal — the one step nobody can skip.** Refused, by name: a round past
  the cap (invariant 4); a "met" resting only on D/X evidence (invariant 13); an R anchor
  to a run that does not exist; a D anchor to a GroupReport or Integration Note
  (summaries are never roots); a `charter:vN` with no such version; a TaskSpec whose
  wave is not open or whose out-of-scope is empty (invariant 5); a Charter version
  without its amendment row; an Integration Note disposing an unknown flag or leaving a
  disposition empty (invariant 11); an unresolvable `derives-from` or an anchor to an
  unknown id; a missing required section. A refusal names what to change in the
  document; agents fix the document and seal again — never route around it.
- **Runs are shared facts:** `mp run record --cmd … --log … [--tree <worktree>]
  [--scope closing]` records an execution once, identified by (tree hash, command,
  output hash); everyone else cites `run:<id>`. Fingerprints bind the **judged tree**,
  not the mission tip. (Field: 26 % of R evidence duplicated another seat's identical
  run — the same suite executed by up to five seats.)
- **Supersession:** `mp supersede <kind>:<id> --by principal|reality|<kind>:<id>
  --reason …` retires any record — artifact, verdict, flag (reopens its disposition),
  evidence, charter version, contract, run. Sealing a new version supersedes the old
  one automatically. **Rules read live records only.** Whatever depended on a
  superseded record appears in **`mp worklist`** — a to-do for the PM to judge, never
  an error and never an automatic re-issue. (Field: 23 of 23 lint findings were lawful
  citations of superseded documents; the only "repair" was re-issuing unchanged content,
  and one close was blocked for 10 h 44 m.)
- **Waves with teeth:** `mp wave open W<n> --mission … --tasks …` is one call per
  fan-out (single-wave missions included) and is **refused while a DRIFT stands or two
  consecutive SUSPICIONs stand** — the ratchet. Only the principal clears them
  (`mp supersede verdict:<id> --by principal`), recorded verbatim; no project rule or
  standing contract outranks this. (Field: a fired ratchet was absorbed under a project
  contract and fan-out continued — nothing mechanical stood in the way.) TaskSpecs seal
  only into an open wave; the wave's Integration Note closes it.
- **`mp calib triggers`** computes the task-cell triggers from the ledger (recovery
  task, post-amendment spec, cap PASS, post-compaction window × `touches-contract`) —
  the PM no longer checks them by hand.
- **Engine relay:** `## Engine relay` sections and `mp relay add|list|export` — the
  upstream channel for observations whose subject is the pipeline itself, exported as a
  PR-ready body. Adopted from the deployment's own `engine-relay/` practice. Flags stay
  about the product.
- **`mp acts --mission`** derives the "acts in your name" list from the journal for the
  Integration Note and sign-off.
- **Schema v2 and `mp migrate`:** 1.0.0 ledgers upgrade in place; their journals replay
  whole; v1 and v1.1 events coexist (`tests/m4_migrate.py`).
- **Tests:** `tests/m2_lint.py` is now the seal gate (every evidence rule refused at
  the door, by name; stale is a worklist item); `tests/m3_dryrun.py` drives a whole
  mission by documents alone; `tests/m4_migrate.py`; fixture documents under
  `tests/fixtures/` are the reference implementation of the document contract. 168
  checks, five gates.

### Changed
- **Calibration is cheap first:** the Calibrator runs alone; with no anchored accusation
  it writes the wave's ALIGNED verdict itself (`## Convened: calibrator-only`) and the
  cell ends there — Challenger and Arbiter are convened only on cause. (Field: 30 cells,
  ~90 seat runs; the expensive seats had work in a minority of them.) The post-compaction
  trigger is bounded: specs written after a compaction and before the next completed
  re-grounding, and only when the spec's `touches-contract` is yes — the engine-neutral
  form of PR #3.
- **Charter is re-issued, never edited in place:** each amendment is a new Charter file
  at the next version whose amendment-ledger row carries the principal's verbatim words;
  sealing v1 ratifies `## Prohibitions` into standing contracts automatically.
  `mp charter amend` is retired (refused with the re-issue instruction).
- **Flags are derived, not carried:** the Stabilizer no longer copies flags into the
  group report (section removed); the Integration Note's flag ledger carries flag ids.
  The Stabilizer's spot-check narrows to "does the cited evidence say what is claimed" —
  existence is the engine's.
- **Seams and the integration round** (PR #2, verbatim): seams are payload contracts
  frozen before the fork; a seam-sharing wave ends with its own bounded integration
  round whose acceptance is a real-objects end-to-end proof. The Architect's Pass 2 now
  detects seams.
- **`mp gate close` records the principal's sign-off**: the closing run is recorded
  beforehand (`mp run record --scope closing`), the mission is presented, and the call
  is made on acceptance.
- **Metrics:** buckets always sum to the task count (`r_other`); rounds derived from the
  reports' rounds; lint no longer reports staleness (worklist does).
- **Deprecated, still working for replay:** `artifact new|seal`, `edge add`,
  `round open|close`, `verdict record`, `flag add|dispose`, `evidence add`,
  `fingerprint take`, `charter seal`, `gate record`, `contract add`. Not the documented
  path; marked DEPRECATED in `--help`.

### Fixed
- The journal could record an OK event that never applied (a seat passed a journal
  sequence number where an artifact id was required; the row rolled back after the
  line was fsynced, and the next id was allocated three times). The write path now
  applies inside a savepoint **before** journaling — an apply failure is journaled as
  REFUSED — and every action validates its referenced ids. Replay is tolerant of the
  historical lines such journals already carry (from PR #1).
- `mp metrics` silently dropped tasks with 0 or > 3 rounds, which disabled the trend
  half of calibration (2 of 70 field accusations were trend-shaped). From PR #1.
- `mp doctor` reported absolute-path registrations as tampering (30 of 31 field
  FAILs); paths are stored relative to the project root and normalized.
- Heading matching is by leading phrase and HTML comments are stripped before
  parsing, so template guidance never becomes a phantom flag.

### Notes
- The three field PRs are absorbed: #2 verbatim, #1's replay tolerance and metrics
  fix, #3's intent in engine-neutral form; #1's Charter special cases are unnecessary
  under supersession.
- Upgrading a live 1.0.0 project: replace the skill folder, then the PM runs
  `mp migrate` once. The one grammar rule seats will meet: the Evidence cell of a
  criteria row is the anchor (`run:7`); trailing annotation is tolerated, prose belongs
  in the sections.
- Round-2 field data is the next input: events per artifact, refusals that bite,
  cells convened vs calibrator-only, worklist size, relay volume.

## [1.0.0] — 2026-08-31

The anti-drift, anti-circular-corroboration release — and the largest change in the
project's history: the engine's species changes from pure prose to prose + a
deterministic substrate. Evidence-mined from the same seven-mission production ledger
as 0.3.0 (433 artifacts, Week 21–27), whose drift had two structural causes: nothing
checks the checker — the PM, the longest-lived context and the primary drift source,
was unaudited mid-mission — and circular corroboration: N documents with one common
ancestor are 1 root + N−1 echoes, but every reader counts documents, not roots. This
release freezes the goal before the mission's document web exists, arms five defense
layers against drift, types every citation by its evidential root, and gives the
invariants an enforcement layer. Rationale record:
`docs/design/DesignDoc_CalibrationAndSubstrate_2026-08-31_v03.md`.

### Added
- **The Charter** (`templates/charter.md`): a frozen per-mission calibration basis,
  sealed before decomposition — the principal's verbatim words plus confirmed
  read-backs (on conflict, the verbatim words govern). Prohibitions are ratified into
  `CONTRACTS.md` in the signing act, zero extra principal interaction, and bind every
  task from wave 1. Only the principal amends it, via the conversational chain,
  recorded verbatim; every amendment marks specs citing the prior version stale. No
  sealed Charter, no fan-out — a one-line fix mission has a one-paragraph Charter.
- **Five defense layers against drift**, each sitting where its question is
  well-posed and cheap: standing-contract prohibitions checked on every task (L1 —
  free, the Crititor already reads the registry); Architect Pass 2 Charter-lint
  before fan-out (L2); a risk-triggered task-level calibration cell (L3 — recovery
  tasks, post-amendment specs, round-3 passes, post-compaction specs); the PM
  re-grounding ritual at every wave boundary (L4 — the only preventive layer, aimed
  at compaction); the aggregate calibration cell at every wave boundary (L5, the
  main force — the actual production escapes were aggregate trends no per-step
  check could see: verification narrowed 100% → 0% across six missions in
  individually legal steps).
- **Calibration cells and two new roles** (`roles/calibrator.md`,
  `roles/challenger.md`; arbiter as a Stabilizer variant;
  `templates/calibration-verdict.md`, one per wave). The Calibrator is deliberately
  starved — sealed Charter, the wave's delivery set, mechanical cross-wave metrics,
  and none of the document web's frame; the Challenger is deliberately fed and must
  discharge each accusation with written authorization or concede — a Charter line,
  a ratified amendment, a recorded principal disposition; derived documents are not
  tender. Two legal accusation shapes: trend (must cite metrics) and contradiction
  (must quote the Charter). Verdicts: ALIGNED launches the next wave; SUSPICION
  forces a PM disposition, and recurrence in consecutive waves auto-escalates — the
  ratchet the PM cannot absorb; DRIFT halts the affected fan-out only, and reaches
  the principal in goal language, never as machinery. Cell inputs are computed by
  rule from the ledger — the PM spawns the cell but cannot curate what it reads.
- **Evidence law:** every evidence citation in a verdict-bearing artifact carries a
  type — R (reality: executed output, fingerprint-bound), F (fixed point: frozen
  before the mission web), D (derived: any mission-era document), X (external:
  fetched and verified) — under six rules: D+D agreement = zero weight; every
  criterion marked "met" needs ≥1 R or F anchor; D never upgrades by being cited
  more; R binds to source state and fails closed on mismatch; summaries are never
  citable roots (flag decay was summaries being used as sources); stale citations
  are flagged, with Charter amendments propagating staleness automatically.
- **Invariant 13 — Echoes are not evidence.** "Agreement among derived artifacts
  adds no evidential weight. No acceptance stands without at least one
  reality-anchored or fixed-point anchor, and reality anchors bind to the source
  state that produced them." (Ledger evidence: coherence laundered error — reading
  more of a wrong-but-consistent document web made the error less visible, not
  more.)
- **The deterministic substrate** (`scripts/mp` — one file, Python ≥ 3.8, stdlib
  only, zero dependencies; agent-facing documentation in
  `references/substrate.md`). Three-layer authority: `ledger/events.jsonl` is an
  append-only journal, authoritative for every state transition **including
  refused operations** — the enforcement layer of "silence is not disposal" must
  not itself work silently; `ledger/mp.db` is a derived SQLite view, rebuildable by
  replay (`mp rebuild`), where invariants become constraints — round cap = CHECK,
  registry collision = UNIQUE, undisposed flags refuse close; markdown stays
  authoritative for judgment prose. Single write path, journal first, under a
  lock; `mp doctor` replays the journal against the DB and reports divergence.
  DrvFS/WSL detection built in.
- **Hardened closing gate and source fingerprints:** `mp gate close` refuses while
  any flag is undisposed, lint fails, or the Charter is stale; gate runs bind their
  log and its hash to a source fingerprint (commit SHA + dirty state + tree hash),
  and verification fails closed on fingerprint mismatch. (Ledger evidence: CRLF
  checkout drift changed byte-addressed hash inputs while `git status` read clean —
  semantically coherent documents on mechanically drifted bytes, invisible to every
  seat.)
- **Invariant 12 — The principal converses; agents operate.** "Every principal
  decision must be expressible and deliverable in one plain sentence. Any pipeline
  step that requires the principal to execute an instruction, operate a tool, or
  absorb machinery detail is an engine defect, not a configuration option." The
  principal's command count is zero — `mp` is agent-internal and self-identifies as
  such. Authority without commands: the principal says it in one sentence, the PM
  reads back and executes on their behalf, recording the verbatim words — and at
  sign-off presents the **"acts in your name" repudiation list** (amendments,
  ratifications, dispositions), repudiable item by item, closing the loop that
  would otherwise let a D-type claim ("PM says the principal approved") pose as an
  F-type anchor. Compaction disclosure becomes a mandatory Integration Note line.
- **Machine-readable headers** on the task-spec, dev-report, and critique
  templates, plus the evidence-type column — verdict-bearing artifacts are now
  mechanically lintable (`mp lint`: typing present, D-only chains, staleness).
- **Tests** (`tests/`): the M1 gate — `mp adopt` on the DIVRA export (433
  artifacts, 7 missions, 67 tasks) followed by `mp metrics` mechanically reproduces
  the retrospective once done by hand; the analysis is now a SELECT and stays the
  regression test (`tests/m1_acceptance.py`, plus `tests/m1_smoke.py`). The M2
  gate (`tests/m2_lint.py`): `mp lint` catches seeded violations of each of the six
  evidence rules, and `mp gate close` fails closed on source drift. The M3 gate
  (`tests/m3_dryrun.py`): a dry-run mission exercises the defense layers —
  prohibition catch, Charter-lint catch, triggered task cell, SUSPICION ratchet,
  DRIFT halt — and closes through the hardened gate. 117 checks, zero failures.

### Changed
- **Default executors flipped** (invariant 12): Researcher, Auditor, and the
  calibration seats default to PM-spawned fresh contexts with engine-fixed inputs —
  parallax is bought with fresh contexts, never with principal labor. "Principal
  runs it in a separate session" remains an optional PROJECT.md binding.
- **Setup shrinks and bootstraps the substrate:** the interview becomes one
  consolidated scouted proposal plus a single veto pass — individual questions only
  for what the scout cannot answer, typically the principal's identity and the week
  scheme. `/mission-pipeline:init` now also runs `mp doctor` (environment check)
  and `mp init` (state creation) — executed by the agent, never by the principal.
- **Python ≥ 3.8 (stdlib only) is required for new missions.** `mp doctor` fails
  the install loudly, never a mission midway. v0.3-era prose ledgers remain
  readable and are imported via `mp adopt`.
- **Semver commitment:** from 1.0.0 on, breaking changes to the binding contract
  (PROJECT.md slots), the `mp` command surface, or the schema (beyond `mp migrate`)
  imply a major bump. The DB carries `schema_meta` and migrates forward.

### Notes
- Released ahead of the first dogfooded mission by the principal's decision: the
  mechanical gates are green; the first field deployments are the dogfood, and their
  ledgers return for analysis through the same `mp adopt` + `mp metrics` path.
- `tests/m1_acceptance.py` needs the DIVRA export under `data/`, which is not
  distributed; the other three test files are self-contained.

## [0.3.0] — 2026-08-19

Frame-parallax release. Mined from a seven-mission production ledger (433 artifacts,
Week 21–27): every seat executed its prompt faithfully — zero invariant violations —
yet a fully-accepted mission shipped 13 latent test failures. The escapes lived in the
contracts, not the execution. This release re-arms the contracts.

### Added
- **Invariant 10 — Reality closes the evidence:** no mission reaches sign-off without
  one full-scope verification run (the closing gate) over the integrated result.
  Task-level verification may be narrowed for speed; the closing gate may not.
  (Ledger evidence: full-suite verification narrowed monotonically 100% → 0% across
  six missions, each step contractually legal, before the escape.)
- **Invariant 11 — Flags route; silence is not disposal:** out-of-frame flags and
  noticed-but-not-fixed items reach the PM verbatim and each gets an explicit,
  recorded disposition. (Evidence: a declared evidence-identity drift decayed
  Constructor → "Notes, non-blocking" → "declared and non-blocking" → absent from the
  closure note — every seat compliant, the risk shipped.)
- **Out-of-frame flag channel:** mandated `Out-of-frame risk` section in the critique
  (exactly one item or a justified "None"; never feeds the verdict), mandated
  `Noticed but not fixed` in the dev report, both carried verbatim by the group
  report and dispositioned in the Integration Note. (Evidence: schema-mandated
  sections landed at 86–97%; prose-only instructions landed at 0.8–35%.)
- **Standing-contracts registry** (`ledger/CONTRACTS.md`, `templates/standing-contracts.md`):
  ratified project invariants that bind every task like acceptance criteria, whether
  or not a spec restates them; violations are automatic CHANGES-REQUESTED; PM drafts,
  principal ratifies at sign-off.
- **Auditor** (optional role, `roles/auditor.md` + `templates/closure-audit.md`): one
  arms-length read before sign-off — does the integrated result deliver the design
  decision's stated goal? Runs by default in a separate principal session; a different
  model family is preferred when available, never required (single-model deployments
  get parallax from fresh session + artifacts-only inputs + a different question).
  Report reaches the principal unfiltered; the PM gets a copy, not a veto.
- **Integration Note** as a mandated artifact (`templates/integration-note.md`):
  merges, escalation decisions, the flag ledger with dispositions, footprint
  reconciliation (ArchPlan predictions vs files actually touched), and the closing-gate
  record at mission close.
- **Architect Pass 2 spec lint** (cold read, feeds the delta veto): pointer
  requirements left unexpanded, unanchorable acceptance criteria, verification-scope
  regression vs earlier waves and the closing gate, missing out-of-scope — plus an
  `Unstated assumptions` section. (Evidence: a requirement reading "implement all
  contracts required by DesignDoc §4–5" produced a criteria table with no
  corresponding row; the contract shipped incomplete and cost 5 of the next
  mission's 12 tasks in recovery.)
- **PM protocol:** read-back of frame-level directives (compiled policy, scope and
  boundary, ≤2 lines, confirmed before it enters any document); commitment-delta veto
  surfaced one item at a time, most critical first; explicit disposition duty for
  every flag; standing-contract curation; the closing gate before sign-off.
- **Stabilizer evidence spot-check** before any accept: sample the critique's
  citations — `file:line` exists and says what is claimed, cited tests re-run green.
  Judging paperwork, not re-reviewing; a failed spot-check returns the critique for
  correction in the same round.
- **Crititor inputs widened:** the standing-contracts registry, and every document the
  spec's mandatory reading names — "inputs, not references," the mission's design
  decision included. Purpose-anchored required changes: meeting the letter of the
  criteria while defeating a written purpose is a Required change, not a Note.
  (Evidence: 87% of specs pointed at the design doc; 0 of 98 critiques read it; the
  one critique in the corpus that did produced the deepest finding of two missions.)
- **PROJECT.md slots:** Document map (mission-rationale location — mid-pipeline
  adoptions point it at their existing tree, never restructure; standing-contracts
  location), the closing gate, and Closure-audit bindings. Setup interview §12–13;
  `/mission-pipeline:init` seeds `ledger/CONTRACTS.md`.

### Fixed
- `/mission-pipeline:init` referenced `${CLAUDE_SKILL_DIR}`, which does not exist in
  plugin command context — both references now use `${CLAUDE_PLUGIN_ROOT}`, so the
  command can actually locate `setup.md` and the templates.

## [0.2.0] — 2026-07-07

### Added
- `/mission-pipeline:init` plugin command — idempotent project initialization:
  creates the state folders, briefly scouts an existing project (stack,
  conventions, verification commands, week evidence; read-only, coexists with
  any established workflow), then runs the setup interview pre-filled with the
  scouted answers so the principal vetoes proposals instead of answering open
  questions.
- Setup reference (`references/setup.md`): explicit read-only scout phase as
  install step 3; the interview now asks only what the scout could not answer.

## [0.1.0] — 2026-07-06

Initial public release.

### Added
- The engine: mission lifecycle, bounded build–critique–stabilize group loop
  (default 3 rounds), wave-based parallel execution, escalation ladder, and the
  nine named invariants (`skills/mission-pipeline/SKILL.md`).
- Six role definitions: PM, Architect, Constructor, Crititor, Stabilizer,
  Researcher (`roles/`).
- Engine/binding separation: read-only engine files + a single per-project
  `PROJECT.md` binding layer; upgrades are drop-in, drift is `diff`-detectable.
- Per-mission ledger outside the source tree
  (`.claude/mission-pipeline/ledger/`, relocatable), with the main-root
  path-anchoring rule for worktree safety.
- Setup interview (`references/setup.md`), including the scout-don't-invent
  week-scheme rule: adopt the project's counter, else `Week01` for new
  projects, else ask — never the calendar week.
- Seven artifact templates: PROJECT.md, task-spec, dev-report, critique,
  group-report, arch-plan, missions-registry (`templates/`).

### Notes
- Extracted from a production deployment that ran multi-wave missions with
  10+ parallel task groups; the packaging (plugin + marketplace) is new in
  this release.
