# Design record — 2.1.0, "make the supervised runtime usable"

Date: 2026-09-13. Author: the PM session that reviewed v2.0.0 with the principal (Zhuo Qiu).
Scope: repair 2.0.0 (commit 56b7d1d, schema 4) to the point where a live deployment can run
on it and a stalled 1.2 deployment can move to it mid-mission. No schema change. Everything here
was verified against the code and by probes before being written down; the probe scripts live
outside the repo. The larger merge of 1.x document derivation with 2.x structured requests
("3.0") is deliberately deferred until more field data returns.

## 0. Where 2.0.0 came from and what it got right

2.0.0 was produced by GPT-ASTRA seats running this project's own Constructor → Crititor →
Stabilizer method: a field audit of the v1.2.0 ledgers (runtime audit, six-layer root cause,
PM-upstream error tracing, cross-version evidence expansion), two design debates (repair design,
PM-supervision design), a four-round implementation CCS, and a dual-platform release check.
Those analysis records are not in this repository (they live in an ignored `data/analysis/`
directory on the maintainer's machine); this document is the in-repo summary of that lineage.

The audit found real defects in the 1.1/1.2 engine, all confirmed from production ledgers:
a later `partial` row was stored as `met` when several rows shared a criterion number;
multi-line risks and relay items were truncated to their first line; run logs were referenced
by path and got overwritten; ACCEPTED could be sealed without any PASS critique; a non-principal
could supersede a DRIFT verdict; the calibration bundle carried only DevReports, never the
delivered files. 2.0.0 fixed all of these and added three structural ideas worth keeping:

- Authority layering: the principal's words (A0), the delegation (A1), the PM's own choices (A2)
  and the implementation (A3) are separate records; standing contracts compile only from A0.
- Approvals bound to a digest of what they judged: a PASS, ACCEPTED or ALIGNED becomes stale by
  computation when inputs, outputs, runs, decisions or authority change.
- A Supervisor seat at three points (root, plan, close) with counterexamples as first-class
  cases that fence only the affected scope.

## 1. What blocks field use today (all verified)

| # | Problem | Evidence |
|---|---|---|
| P1 | `--actor controller` is accepted from the CLI; a hand-written `run.begin`/`run.finish` is recorded as `local-controlled-execution` and can close a mission without any process running | probe: fabricated closing run → `root.status = CLOSED` |
| P2 | Local `run.execute` is not contained (writes home, has network) but is labelled "controlled" | probe: hostile script wrote `~/MP-ESCAPE-MARKER.txt` |
| P3 | Three ordinary `task.record` revisions while a case is open exhaust the rebase budget; every recovery action is then refused; the mission can never close | probe: all 9 recovery actions refused |
| P4 | The 12-call correction budget is per mission, not per case; the 13th case is terminal | probe |
| P5 | Screening/contest jobs expire after 300 s; local subagents routinely take longer; `job.resume` needs a prior `jobs.expire` and misreports `BUDGET_EXHAUSTED`; after two resumes only dismissal remains | probe |
| P6 | `case.resolve` has no deadline and no job/contest check: a Supervisor can dismiss an unscreened case or pre-empt a pending contest | probe |
| P7 | A PM `decision.record` without `tasks` invalidates every accepted task in its domain | probe: consume → `STALE_DEPENDENCY` |
| P8 | Files in `write_paths` but not in inputs/outputs escape every recheck after acceptance | probe: helper rewritten, consume OK |
| P9 | A report with no criteria table bypasses the table/JSON check; `audit.record` has no outcome; `close.review` accepts any string; `flag.raise` is unguarded | probe |
| P10 | `AUTHORIZED_CANCELLED` is read in five places and written nowhere | code |
| P11 | A dead RUNNING run cannot be aborted by any other session | code |
| P12 | Writer identity hashes hostname + `WSL_DISTRO_NAME`; a cron/systemd launch or a PC rename locks the ledger with no in-band recovery | probe |
| P13 | Every write re-reads and re-verifies the whole journal (linear growth); every `run.execute` hashes the whole tracked tree (0.95 s here, 40 s reported in the field) | probe |
| P14 | Migration is an archive: `legacy.adopt` writes a marker only; an open 1.2 mission must redo the entire chain and re-earn every acceptance; closed missions refuse adoption | probe on the real 421-event ledger |
| P15 | `mp seal` overwrites `source_blob` unconditionally; refuses unrelated sections (`MIXED_NONE`) for every action; cannot supply `contract_scope_digest`, `review_basis`, `admission`, `critique`, `revises` | probe |
| P16 | One single-task mission costs 32 CLI calls, 24 requests and 5 documents; SKILL.md is 48 lines, roles 7–9 lines; no worked example; the only manual calibration triggers (`recovers`, `touches_contract`) are undocumented | measured |
| P17 | `scripts/mp` (5061 lines) and `legacy_v3.py` (5021 lines) differ by 58 lines; `tests/m9_migration.py` and `m1_acceptance.py` need ignored data, so the public suite cannot run elsewhere | measured |
| P18 | Managed mode ships a real bubblewrap sandbox but no model driver; `parallel_host_tools:false` is self-declared; one `managed run` = one packet, ≤32 steps, ≤300 s | measured |

## 2. Specification (the contract every 2.1 change is built to)

Numbering S1–S19. "Local" means `config.project.mode == "local"`. Schema stays 4. Existing 2.0
ledgers must keep working (labels and identities below have compatibility paths).

**S1 — `controller` is an internal identity.** `cli.py`, `field_adapter.py` and
`bridge.serve_one` refuse actor role `controller` (`ROLE_FORBIDDEN`, "controller is the executor's
internal identity"), including via `MP_ACTOR`. `runner.execute` and `ManagedBroker` still construct
it in-process.

**S2 — honest local execution label.** `run.finish` records `assurance="local-execution"` for a
local executor (was `local-controlled-execution`). Every check that accepted the old label accepts
both. Docs and `capabilities` state: local execution freezes inputs, captures logs and outputs,
and does not contain the process.

**S3 — rebase never deadlocks.** In `review.rebase`, when the case already has two durable rebases,
the engine (a) closes the current case: `status="TARGET_REPLACED"`, barrier `RELEASED`, permits
inactive, any pending contest `status="SUPERSEDED"` and its job `COMPLETE`; (b) creates a successor
case with the same mission, lineage, scope, target, target_kind, source_blob, counterexample_blob,
audit and audit_stance, a new target_digest and fact, `supersedes=<old id>`, `repairs` carried
over, `status="REPORTED_PENDING_SCREEN"`, barrier `PENDING_SCREEN`, a fresh screening job and
`review_head` = current basis head. Returns `{"case": <new>, "superseded": <old id>}`.

**S4 — correction budget per case.** `issue.screen` and `contest.decide` charge
`<case id>:correction` (cap 12). `contest()` checks the same key. A mission-level counter
`<lineage>:correction_total` is kept for reporting only (no cap).

**S5 — review deadlines by mode.** `project.configure` stores `review_deadline_seconds`
(default 86400 local, 300 managed; explicit value allowed, integer ≥ 60). Every screening,
contest, supplement, resume and repair-compliance deadline uses it (the UPHOLD repair window is
`max(86400, value)`). `job.resume` also accepts a PENDING/AWAIT_REPAIR job whose deadline has
passed (no prior `jobs.expire` needed), keeps the two-resume cap, and reports `REVIEW_EXPIRED`
with `recovery` text when the cap is spent. `issue.screen` / `contest.decide` on an expired job
auto-resume inside the same transaction when a resume remains (generation+1, `auto_resumed=True`),
otherwise refuse `REVIEW_EXPIRED`. `jobs.expire` stays for controllers.

**S6 — dismissal is contestable and cannot pre-empt a contest.** `case.resolve` refuses
`CONTEST_PENDING` while a contest is PENDING or INPUT_INCOMPLETE, and refuses `SCREENING_REQUIRED`
for `DISMISSED` on a case that has no `screening_author`. `case.contest` is open to pm and every
reporter role (constructor, crititor, stabilizer, auditor, calibrator, challenger, architect,
researcher, supervisor) on a case whose status is DISMISSED, ESTABLISHED, VERIFIED_FIXED or
AUTHORIZED_EXCEPTION and which is not `independent_final`. One contest per case (unchanged).

**S7 — `obligation.cancel`.** New action, pm with grant permission `defer` (or principal):
`{obligation, grant, domain, owner, reason_blob}` → status `AUTHORIZED_CANCELLED` with the same
fields as defer plus `cancelled_by`.

**S8 — blanket decisions do not retro-invalidate accepted work.** `decision_applies(decision,
task)` becomes an instance method: domain must match; if the decision lists `tasks`, the task
must be listed; otherwise the decision applies only if the task has no current ACCEPTED acceptance
created before `decision.created`. All call sites (qualify, plan_review, calibration_basis) use it.

**S9 — abort a dead run.** `run.abort` by pm or controller from any session is allowed when the
run is RUNNING and `lease_until < now`: status `EXPIRED`, `satisfied=False`,
`failure_code="RUN_LEASE_EXPIRED"`. The owner-session path is unchanged.

**S10 — product digest covers `write_paths`.** `calibration_basis` files = task outputs +
task write_paths + required-run inputs, deduplicated, order-stable.

**S11 — criteria table required.** `report.record` with a task that has obligations and outcome
COMPLETE, PASS or ACCEPTED refuses `CRITERIA_TABLE_REQUIRED` when the document has no criteria
rows.

**S12 — closed outcome sets.** `audit.record.outcome` ∈ {PASS, FINDINGS, INPUT_INCOMPLETE}
(PASS needs zero findings, FINDINGS needs ≥1; derived when absent). `close.review.outcome` ∈
{PASS, FAIL, INPUT_INCOMPLETE}. `flag.raise` is limited to pm and reporter roles and requires the
mission to have a root or intake. `mission.close` requires the audit outcome ∈ {PASS, FINDINGS}.

**S13 — `delivery.record` vs `run.export`.** `delivery.record` refuses `EXPORTED_OUTPUT` when the
current delivery for that path was produced by a run.

**S14 — seal conveniences (local only; managed unchanged).** `mp seal`: sets `source_blob` only
when the block does not name one and always records `document_blob`; validates list sections only
for `report.record`; when absent, fills `contract_scope_digest` (root/plan review), `review_basis`
(the six review actions), `admission` (latest admission of the task), `critique` (current PASS
critique of the task, acceptance only) and `revises` (current report of the same kind); marks
`reading_assurance="self-asserted"` when it filled a review field; echoes the submitted request in
its output.

**S15 — writer identity.** `environment_id()` = sha256(platform family, token)[:24], token read
from `<config dir>/mission-pipeline/writer-id` (created with random hex on first use; POSIX
`$XDG_CONFIG_HOME` or `~/.config`, Windows `%APPDATA%`). `legacy_environment_id()` keeps the old
formula; `owner()` accepts either; `maintenance recover` rewrites the owner record to the new id.
New `maintenance takeover --confirm <project id>` (requires `--actor principal`) claims a ledger
whose owner environment is unreachable: new environment, epoch+1, `takeover_from` recorded.

**S16 — per-write cost.** `recover()` verifies only the journal tail past a watermark
(`verified_seq` + byte offset in `runtime_meta`); the full replay comparison stays in `doctor`
and `rebuild`. `source_manifest` identity_version 3: clean tracked files take their git blob id
from `git ls-files -s -z`; only files reported by `git status` are hashed with sha256.

**S17 — migration continuity.** `adoption_plan` adds `acceptances` (every ACCEPTED verdict from
a sealed GroupReport: legacy mission, task key, artifact, sha256, seq). `legacy.adopt` adopts all
VERIFIED overlays of the legacy mission when `artifacts` is omitted. New action `legacy.accept`
(pm): `{mission, obligation, legacy_artifact}`; requires the adopted scope, a VERIFIED overlay and
a matching acceptance; sets the obligation MET with `evidence="legacy:<artifact>"`,
`assurance="legacy-recorded"`. `mission.close` accepts such obligations; `bundle.record` includes
adopted overlay blobs. The walkthrough documents the mid-mission upgrade path.

**S18 — hygiene.** `scripts/mp` becomes a launcher (≤ 40 lines): `--bridge-stdio`,
`MP_COMPAT_V3=1` → `legacy_v3.main`, otherwise the v4 CLI; the v3 guard (refuse when a v4
owner/manifest exists) and exit codes move into `legacy_v3.py`, whose "replay-only" raise is
removed. `m1_*`–`m7_*` must pass unchanged. `tests/m9_migration.py` skips its real-data test with a
message when the data is absent and gains a synthetic fixture test (build a v3 ledger with one
accepted task under `MP_COMPAT_V3=1`, migrate, adopt, `legacy.accept`, close under v4).
`m1_acceptance.py` exits 0 with `SKIP` when the corpus is absent.

**S19 — documents.** SKILL.md operational again (cast, lifecycle in order with the request per
step and the seal alternative, refusals, closure, calibration, recovery, invariants restored in
2.x vocabulary, a plain statement of local vs managed assurance). Each role file: inputs, exact
actions, refusals it will meet, what it never does. `references/walkthrough.md`: a complete
single-task mission with every request and response, plus the 1.2 → 2.1 mid-mission upgrade.
`runtime-v4.md` updated for S1–S17. Templates added for plan review, close review, screening,
case resolution, contest decision, recovery permit, obligation defer/cancel. README and CHANGELOG
for 2.1.0; managed mode described as experimental until a model driver exists.

## 3. What 2.1 does not do

- No schema change, no new record shape, no document-derived requests beyond S14.
- No sandbox for local execution (S2 makes the label honest instead).
- No change to the three-round product cap; the exits are `obligation.defer`/`obligation.cancel`
  under a grant, or a principal amendment.
- Managed mode is unchanged in code and demoted in documentation.

## 4. Gates for the release

All 22 existing entry points plus the new tests pass on WSL; the walkthrough is executed end to
end through the public CLI; the real 421-event 1.2 ledger migrates, adopts its open mission,
accepts a legacy task and closes under v4 (on a copy); native Windows is re-run by the maintainer
before field deployment (this session cannot run Windows).

## 5. Document map

What each document is for, so a future change lands in one place instead of three.

| Document | Audience | Contains | Does not contain |
|---|---|---|---|
| `skills/mission-pipeline/SKILL.md` | the agent operating a mission | the cast with each seat's exact actions, the lifecycle in order, the refusal table with fixes, closure, calibration, the counterexample path, the invariants, the assurance statement | full field lists, transport details, installation |
| `references/walkthrough.md` | an operator running their first mission, or upgrading one | every request of a complete single-task mission with its command line and response fields, the 1.2 mid-mission upgrade, the recovery commands | the exhaustive contract |
| `references/runtime-v4.md` | an agent that needs the exact rule | the typed request surface: required fields, outcome sets, digests, budgets, deadlines, seal behaviour, identity, migration, managed transport, failure taxonomy | worked examples, installation |
| `references/setup.md` | whoever installs or moves a deployment | interpreters, root and ledger binding, writer identity and ownership, managed controller, WSL bridge and post-upgrade re-registration, product environments, principal bindings | the request contract |
| `references/ledger.md` | anyone inspecting on-disk state | what each path in the ledger directory is, what lives outside it, read-only inspection discipline | workflow semantics |
| `references/parallel.md` | the PM and the Architect before a fan-out | waves, disjoint write scopes, the write-path side of the calibration basis, holds and unrelated work, seams | anything single-task missions need |
| `references/substrate.md` | a reader deciding which surface to use | v4 versus frozen schema-3 compatibility, and the two execution substrates named honestly | new detail of its own |
| `roles/*.md` | the seat being spawned | purpose, inputs to read, exact actions with templates, refusals it will meet, what it never does | the lifecycle, which is SKILL.md's |
| `templates/*.md` | any seat about to submit a judgement | the document shape plus an `mp-json` block with every required field as a placeholder | prose that a verdict should carry instead |
| `README.md` | someone evaluating or upgrading the plugin | what changed in this release, the upgrade path, install, supported environments, validation | operating instructions |
| `CHANGELOG.md` | the maintainer and returning users | the defect each change repairs, in release order | design rationale, which lives in `docs/design/` |

Rules of thumb. A fact about **what the engine does** belongs in `runtime-v4.md` and is referenced elsewhere, never restated with different words. A fact about **how to do it** belongs in the walkthrough. A rule a seat must not break belongs in its role file and, if it is structural, in SKILL.md's invariants. When SKILL.md and a role file disagree, SKILL.md governs; when SKILL.md and `runtime-v4.md` disagree, the code decides and both are wrong.
