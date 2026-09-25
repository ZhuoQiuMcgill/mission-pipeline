---
name: mission-pipeline
description: Run supervised multi-agent engineering with scoped PM delegation, independently reviewed roots and plans, bounded build-critique-stabilize loops, current evidence and mandatory closure audit. Start from references/walkthrough.md for a complete worked mission.
---

# Mission Pipeline 2

Mission Pipeline runs engineering work through separate agent seats: one builds, one critiques, one accepts, and an independent Supervisor checks that the work still matches what the principal actually asked for. Every judgement is a typed JSON request to a deterministic runtime that journals it with the original source bytes, so a PASS, an ACCEPTED or an ALIGNED goes stale by computation as soon as its inputs, outputs, runs, decisions or authority change. The principal talks in conversation; agents operate the runtime.

Read `references/walkthrough.md` first: it is one complete single-task mission, every request and response, through the public CLI. `references/runtime-v4.md` is the full request contract, `references/setup.md` the installation and recovery paths. The schema-3 free-form commands are compatibility-only and cannot operate on v4 state.

Every request looks like this, and every response is one UTF-8 JSON object:

```text
python <skill>/scripts/mp --root <project> --actor pm api --request-file request.json
python <skill>/scripts/mp --root <project> --actor supervisor seal reviews/plan-review.md
```

## The cast

Role files are in `roles/`. Point a spawned agent at its role file, PROJECT.md and its task, with absolute paths.

| Role | One line | Actions it may submit |
|---|---|---|
| principal | Owns goals and reserved conditions. Speaks in conversation; the PM records the words. | `authority.record`, `authority.amend`, `grant.record`, `grant.revoke`, `contract.retire`, `environment.register`, `canonical.register`, `project.configure`, `latch.release`, `mission.close`, `mission.reopen`, `legacy.adopt` |
| PM (`roles/pm.md`) | Translates intent into a plan, dispatches, integrates, closes. Never builds, never judges a product. | `intake.create`, `root.propose`, `root.activate`, `decision.record`, `plan.record`, `task.record`, `task.replace`, `task.admit`, `requirement.record`, `wave.open`, `wave.integrate`, `task.dispatch`, `consume`, `recovery.permit`, `case.contest`, `case.supplement`, `obligation.defer`, `obligation.cancel`, `flag.raise`, `flag.change`, `bundle.record`, `jobs.expire`, `job.resume`, `run.abort`, `context.compacted`, `legacy.adopt`, `legacy.accept`, `mission.close` |
| Supervisor (`roles/supervisor.md`) | The independent seat at three checkpoints: root, plan, close. Also screens counterexamples. | `root.review`, `plan.review`, `close.review`, `issue.screen`, `case.resolve`, `review.rebase`, `rule.record`, `rule.retire`, `issue.report`, `case.contest` |
| Architect (`roles/architect.md`) | Reads code, maps producers, inputs, write collisions and dependencies. Proposes; PM disposes. | `issue.report`, `case.contest` |
| Constructor (`roles/constructor.md`) | Builds through admitted write paths and runs the controlled verification. | `work.write`, `run.execute`, `delivery.record`, `report.record` (development), `task.dispatch`, `task.claim`, `consume`, `issue.report`, `case.contest`, `case.supplement` |
| Crititor (`roles/crititor.md`) | Independently checks every acceptance row against the delivered bytes and the run logs. | `report.record` (critique), `run.execute`, `issue.report`, `case.contest` |
| Stabilizer (`roles/stabilizer.md`) | Independently accepts or returns the work, and decides an assigned Contest. | `report.record` (acceptance), `contest.decide`, `calibration.record`, `latch.release`, `consume`, `rule.record`, `rule.retire`, `review.rebase`, `issue.report`, `case.contest` |
| Calibrator (`roles/calibrator.md`) | Reads original authority and the delivered bytes, without the PM's defence, and judges drift. | `calibration.record`, `issue.report`, `case.contest` |
| Challenger (`roles/challenger.md`) | Answers a calibration accusation with real applicable authority, or concedes. | `issue.report`, `case.contest`, `case.supplement` |
| Auditor (`roles/auditor.md`) | The mandatory arms-length read of the complete bundle before the close. | `audit.record`, `audit.agree`, `issue.report`, `case.contest`, `case.supplement`, `review.rebase` |
| Researcher (`roles/researcher.md`) | Gathers external or local evidence inside an assigned read scope. | `issue.report`, `case.contest` |

`controller` is the executor's internal identity. It is constructed in process by `run.execute` and by the managed broker; a CLI, adapter or bridge request with `--actor controller` (or `MP_ACTOR=controller`) is refused `ROLE_FORBIDDEN`.

## Lifecycle, in order

Each step names its request, its submitter, what the engine checks, and the template that `mp seal <document>` submits for you. Seal takes a Markdown document containing a fenced ```mp-json``` block, stores the whole document as the `source_blob`, and submits that request.

1. **Install and bind.** `capabilities`, then `init`, then `doctor`. `init` selects schema 4, local mode and an atomic writer-environment owner. An existing 1.x ledger goes through `migrate --plan` and `migrate` instead, see the walkthrough.
2. **Record the principal.** `authority.record` (principal) with the original words as `source_blob`, stable `goals` and reserved `constraints`; `constraint_scopes` marks a clause `mission` or `project`. Then `grant.record` with scope, `domains` and `permissions` from `choose`, `revise`, `defer`, `close`. The engine stores the bytes and refuses a grant that contradicts a principal constraint (`AUTHORITY_CONFLICT`).
3. **Open an intake.** `intake.create` (pm). An intake exists before an active mission; a new intake for the same mission names `revises_intake`.
4. **Propose the root.** `root.propose` (pm), template `templates/charter.md`. A candidate creates no contract.
5. **Review the root.** `root.review` (supervisor) with MATCH, MISMATCH or INPUT_INCOMPLETE, template `templates/supervisor-review.md`. The engine compares the candidate goal inventory with the principal's (`GOAL_COVERAGE_GAP`) and requires a current `contract_scope_digest`; in local mode `seal` fills that field after `contracts.snapshot`.
6. **Activate.** `root.activate` (pm) naming the candidate and the MATCH review. Activation is atomic: it creates the root, compiles the principal's standing contracts and opens wave 1. A stale candidate, authority or contract scope refuses `STALE_ROOT_REVIEW`.
7. **Record PM choices.** `decision.record` (pm) with grant, domain, actual `effects`, `rationale_blob` and optional `tasks`, which must be tasks of the decision's own domain (`DECISION_DOMAIN_MISMATCH`). A decision that lists no tasks applies to the whole domain going forward and does not invalidate work accepted before it.
8. **Plan.** `plan.record` (pm) carrying every principal goal and one obligation per goal (`GOAL_COVERAGE_GAP`, `INVENTED_OBLIGATION`). Then `task.record` (template `templates/task-spec.md`) with obligations, grant, domain, required and allowed effects, input blobs, exact `write_paths`, delivery `outputs`, dependencies and wave. `environment.register` (principal) names the real interpreter; `requirement.record` (pm) fixes argv, cwd, inputs, environment, success predicate and output mappings, with `scope: "closing"` for the mission gate.
9. **Review the plan and admit.** `plan.review` (supervisor) with PASS, template `templates/plan-review.md`; the engine checks that every obligation still REQUIRED has an authorized producer (`MISSING_PRODUCER`; an obligation already MET, deferred or cancelled needs none) and that no task requires an excluded effect (`INFEASIBLE_TASK`). Outcomes are PASS, FAIL and INPUT_INCOMPLETE; only PASS admits. `task.admit` (pm) then produces the current admission. A changed plan, task, authority or accepted dependency needs re-admission.
10. **Dispatch.** `task.dispatch` (pm) creates a fenced ticket; `task.claim` (constructor) claims it. Both recheck barriers and latches. A single-task mission can go straight to `work.write` with the admission.
11. **Build.** `work.write` (constructor) with task, admission, path, `source_blob` and `expected_sha256` of the file as it stands now. Only reviewed `write_paths` are writable; a changed head refuses `STALE_PRODUCT_HEAD` instead of overwriting another edit.
12. **Verify.** `run.execute` (constructor, crititor or stabilizer only) with requirement and admission. The engine freezes the declared inputs, checks the interpreter and import origins, runs argv with no shell interpolation, stores stdout, stderr and declared outputs in CAS, and exports outputs to the reviewed delivery paths. Completion is not satisfaction: the requirement's predicate decides.
13. **Report.** `report.record` kind `development` (constructor, `templates/dev-report.md`), then `critique` (crititor, `templates/critique.md`), then `acceptance` (stabilizer, `templates/group-report.md`). Every document with obligations and a positive outcome carries a criteria table that agrees with the structured `criteria`. Three rounds maximum; a revision names its current predecessor.
14. **Calibrate when required.** `bundle.record` (pm) for the task, then `calibration.record` (calibrator or stabilizer, `templates/calibration-verdict.md`).
15. **Integrate.** `consume` (pm) records formal consumption; `wave.integrate` (pm, `templates/integration-note.md`) closes the wave after rechecking every task. `wave.open` opens the next one.
16. **Close.** `bundle.record` for the mission, `audit.record` (auditor, `templates/closure-audit.md`), `close.review` (supervisor, `templates/close-review.md`), then `mission.close` (pm, `templates/mission-close.md`).

## What the engine refuses, and the fix

A refusal is a JSON object with `ok:false`, a `code` and a `detail`. Deterministic refusals are corrected, not retried with a new request id. Never hand-edit ledger state to get the same effect.

| Code | What actually happened | What to do |
|---|---|---|
| `ROLE_FORBIDDEN` | This seat cannot submit this action, or `--actor controller` was used | Submit from the role in the cast table above |
| `AUTHORITY_CONFLICT` | The grant is revoked, expired, out of domain, or the effect contradicts a reserved condition | Ask the principal for `authority.amend`, or choose an effect inside the grant |
| `DECISION_DOMAIN_MISMATCH` | A `decision.record` names a task whose domain differs from the decision's; it would never apply to that task | Record the decision in the task's domain under a grant that covers it, or leave the task out |
| `STALE_CONTRACT_REVIEW` | A root or plan review carried no current `contract_scope_digest` | `contracts.snapshot`, read the named sources, resubmit; `mp seal` fills it in local mode |
| `STALE_ROOT_REVIEW` / `STALE_PLAN_REVIEW` | The candidate, plan, task set or authority changed after the review | Re-review the current object, then activate or admit |
| `STALE_ADMISSION` / `STALE_DEPENDENCY` | The admitted task, its authority or a consumed predecessor changed | `task.admit` again on the current task |
| `STALE_PRODUCT_HEAD` | The working file changed since you read it | Re-read the file, recompute `expected_sha256`, write again |
| `WRITE_SCOPE_CONFLICT` | The path is not in the task's reviewed `write_paths` | Have the PM revise the task and re-admit |
| `INVALID_INPUT` from `work.write` | The file is larger than the 8 MiB (8,388,608-byte) per-write limit; the refusal carries `limit` and `size` | Split the file, or produce it as a declared output of a controlled run |
| `REQUIRED_VERIFICATION_UNSATISFIED` | The latest attempt for a required run is pending, failed or missing | Run it; a new report cannot promote a failed attempt |
| `CRITERIA_TABLE_REQUIRED` | A COMPLETE, PASS or ACCEPTED report for a task with obligations has no criteria rows | Add the criteria table to the document and seal again |
| `CRITERIA_SOURCE_CONFLICT` | The structured `criteria` contradict or omit a table row | Make them agree; a later partial row never disappears into an earlier met row |
| `CURRENT_DEVELOPMENT_REQUIRED` | The critique or acceptance does not sit on the current development report | Record the development report for the current product first |
| `CURRENT_INDEPENDENT_PASS_REQUIRED` | The acceptance cites a stale critique, or the same session wrote both | Get a current PASS from a different seat |
| `UNMET_OBLIGATION` | A positive report or a consumption has an obligation not met | Meet it, or `obligation.defer` / `obligation.cancel` under a defer grant |
| `DEFERRAL_INCOMPLETE` | A deferral or cancellation names no owner or reason, or at close a disposition has lost its grant and domain (a 2.1.0 plan re-record stripped them) | Submit the same `obligation.defer` or `obligation.cancel` again with grant, domain, owner and `reason_blob` |
| `SCOPED_BARRIER` | An unresolved counterexample fences this task or obligation | Screen the case, repair under a permit, or work an unrelated scope |
| `CALIBRATION_HALT` | An active DRIFT or ratchet latch covers this scope | `latch.release` by the principal, or an independent DISMISS_ORIGINAL |
| `STALE_REVIEW_INPUT` | A review was submitted without the current `review_basis` | `review.snapshot`, read the blobs, resubmit |
| `REVIEW_REBASE_REQUIRED` | The case target or the applicable authority changed since your reading | `review.rebase` for the same case, reread, then judge |
| `REVIEW_EXPIRED` | The screening or contest job passed its deadline and no resume remains | Read the `recovery` field; the case keeps its hold until the named exit |
| `CONTEST_PENDING` | `case.resolve` was attempted while a contest is open | Let the independent decision land; a Supervisor cannot pre-empt it |
| `SCREENING_REQUIRED` | A dismissal was attempted on a case nobody screened | `issue.screen` first |
| `BUDGET_EXHAUSTED` | A finite budget is spent: 3 product rounds, 2 repairs per case, 12 corrections per case, 2 run takeovers, 2 resumes | Use the named exit, not a rename |
| `CASE_NOT_CONTESTABLE` / `CONTEST_FINAL` | The case was replaced by a successor, or its independent decision is already final | Contest the successor case, or accept the final result |
| `AUDIT_OUTCOME_REQUIRED` | The audit named at close is INPUT_INCOMPLETE | Complete the bundle and record a PASS or FINDINGS audit |
| `INVALID_REVIEW_DEADLINE` | `review_deadline_seconds` is not an integer of at least 60 | Configure a real number of seconds |
| `STALE_BUNDLE` | Delivered bytes, evidence or authority changed after the bundle | `bundle.record` again, then re-audit and re-review |
| `INPUT_INCOMPLETE` | Required bytes are missing from the bundle, or an admitted or executed task's declared output (`path`, `task`) has no delivery snapshot | Restore or re-export them; missing input is never a PASS |
| `CLOSURE_REVIEW_REQUIRED` | The audit or close review is missing, stale or not PASS | Rebuild the bundle and obtain both current reviews |
| `CLOSING_RUN_UNSATISFIED` | No completed, satisfied run with `scope: "closing"` | Execute the closing requirement over the integrated result |
| `OPEN_FLAG` | A live product flag has no disposition | `flag.change` with retire, replace, reopen or dispose |
| `EXPORTED_OUTPUT` | `delivery.record` tried to overwrite a delivery a run produced | Re-export from a run; a hand-recorded file cannot replace controlled output |

## Closure

`mission.close` needs all of the following at once, rechecked inside the same transaction:

- every obligation MET, AUTHORIZED_DEFERRED or AUTHORIZED_CANCELLED, each deferral or cancellation still covered by its defer grant;
- every task not REPLACED carrying current acceptance, or wholly excepted by deferred or cancelled obligations;
- no live OPEN flag, no applicable barrier, no active latch;
- a bundle with status READY over the current delivery;
- `audit.record` with outcome PASS or FINDINGS over that bundle, `INPUT_INCOMPLETE` blocks the close;
- `close.review` with outcome PASS over the same bundle;
- a COMPLETE and satisfied run whose requirement has `scope: "closing"`, with its inputs still current;
- a close grant for the PM, or the principal submitting the close directly.

Authorized gaps are returned in the close `outcomes`, with owner and reason. A deferral is a disclosed gap, not a repair. `mission.reopen` is an explicit principal action.

## Calibration

`bundle.record` collects original authority, grants, source documents, decisions, run inputs and logs, and the delivery snapshots. Citing a DevReport is not a bundle; missing bytes make the bundle INPUT_INCOMPLETE. A task's declared outputs need their delivery snapshots once the task has an admission of its current digest or any recorded run; a later task that has not started yet does not block a bundle for earlier work.

`calibration.record` judges one scope: a task cell (`task` plus `wave`) or an aggregate wave cell (`wave` alone). Outcomes are ALIGNED, SUSPICION, DRIFT and INPUT_INCOMPLETE. The Calibrator receives the principal's original words, the authorized A2 decisions and the actual delivered bytes; the PM's argumentative defence is not part of that basis.

DRIFT creates a mandatory case and a latch at once. Two consecutive aggregate SUSPICION verdicts trip the same ratchet. A latch releases through `latch.release` by the principal, or by a Stabilizer whose contest ended DISMISS_ORIGINAL on that latch's case. A later ALIGNED verdict never erases a standing latch.

Task calibration is mandatory when `task.record` sets `recovers` (this task repairs a case), or when the root has been revised, or when `touches_contract` is set after a recorded `context.compacted`. Those two fields are the only manual triggers; everything else is computed.

## Counterexamples and recovery

The path is: case, barrier, screening, permit, repair, resolve or contest.

1. Any reporting seat submits `issue.report` with `kind: "MANDATORY_COUNTEREXAMPLE"`, `source_blob`, `counterexample_blob`, a `target`, and either affected `tasks` and `obligations` or a resolvable `authority_span` quote. One receipt creates the case, a scoped PENDING_SCREEN barrier, the fence and the screening job. Duplicate facts reuse the same case. `kind: "ADVISORY"` blocks nothing.
2. The Supervisor submits `issue.screen` with ESTABLISHED or DISMISSED (`templates/issue-screen.md`). A dismissal of a case an Auditor raised goes straight to a Contest instead.
3. The PM may issue a `recovery.permit` (`templates/recovery-permit.md`) for at most two repairs per case. The permit authorizes work inside the existing grant while ordinary consumption and closing stay blocked. It cannot waive another hold.
4. `case.resolve` (`templates/case-resolve.md`) ends the case with DISMISSED, VERIFIED_FIXED or AUTHORIZED_EXCEPTION. It refuses `CONTEST_PENDING` while a contest is open and `SCREENING_REQUIRED` for a dismissal nobody screened. VERIFIED_FIXED names the actual repair tasks, or a corrected pre-active candidate, and must state that the counterexample is eliminated.
5. `case.contest` is open to the PM and to every reporting seat on any case that is not replaced by a successor and not already final, so a screening nobody reached in time can still be put in front of an independent Stabilizer. An Auditor's substantive disagreement creates one automatically. `contest.decide` (`templates/contest-decision.md`) belongs to a fresh independent Stabilizer endpoint, and its result applies directly with no second Supervisor signature: DISMISS_ORIGINAL, REPAIR_VERIFIED, AUTHORIZED_EXCEPTION_VERIFIED, UPHOLD, MODIFY_SCOPE or INPUT_INCOMPLETE. INPUT_INCOMPLETE buys one `case.supplement`, not a second merits contest.
6. Budgets are per case: 12 corrective review calls, 2 repairs, 1 merits contest, 1 supplement. A mission-level correction total is kept for reporting only.
7. Review deadlines come from `project.configure`'s `review_deadline_seconds`: one day in local mode, 300 seconds in managed mode. An expired job auto-resumes in place when a resume remains, and otherwise refuses `REVIEW_EXPIRED` with a `recovery` field. Two resumes per job.
8. When the case target or its authority changes, `review.rebase` records the new reading. Two durable rebases per case; the third closes the case as TARGET_REPLACED and opens a successor case with the same lineage, scope and counterexample, so the mission is never left with a hold nobody can act on.
9. The exits from a hold that cannot be repaired are: an independent contest result, an AUTHORIZED_EXCEPTION under a real defer grant, `obligation.defer` or `obligation.cancel`, or a principal amendment.

## Invariants

Changing one of these is forking the method, not configuring it.

1. **Separate hands.** Build, critique and acceptance are three seats. An acceptance whose critique came from the same session refuses `CURRENT_INDEPENDENT_PASS_REQUIRED`.
2. **The principal converses; agents operate.** Every principal decision is expressible in one plain sentence. A step that asks the principal to run a command is an engine defect, not a configuration.
3. **Echoes are not evidence.** Agreement among derived documents creates no principal requirement and no acceptance. Positive gates need a satisfied run and the actual delivered bytes.
4. **Approvals bind to what they judged.** Target, product, authority, dependency, contract-scope and review digests are recomputed at every positive use. A stale approval is refused, never silently reused.
5. **Authority has layers.** A0 is the principal's words, A1 the grant, A2 the PM's choice, A3 the implementation. Only `authority.amend` changes A0, and only `contract.retire` retires a standing contract.
6. **Corrections inside a grant need no fresh permission.** Do not demand literal user wording for an authorized chart, layout, algorithm or local implementation choice.
7. **A refusal names its fix.** Correct the input, do not retry with different arguments, do not route around the gate, do not edit the installed engine as a project workaround.
8. **Missions never stall by procedure.** Every hold has a named exit, and exhausting a budget opens the successor path rather than a dead end.
9. **Bounded rounds, then dispose.** Three product rounds per lineage; renaming or replacing a task keeps its budget. The exits are `obligation.defer`, `obligation.cancel` or a principal amendment.
10. **A deferred gap stays a gap.** AUTHORIZED_DEFERRED and AUTHORIZED_CANCELLED carry an owner and a reason and are disclosed in the close outcomes. Never relabelled as repaired.
11. **Flags route; silence is not disposal.** Noticed-but-not-fixed items become live flags at seal, and a live flag refuses the close.
12. **Holds are scoped.** A case fences its own tasks and obligations. Unrelated work continues while it is screened.
13. **Independence is structural.** Only the assigned endpoint decides an assigned job, and no Supervisor overwrites an independent final result.
14. **Provenance is never claimed beyond what the host proves.** Local role labels are self-asserted; see below.

## Assurance, honestly

**Local mode** is the default and the mode this repository can actually run. Its data and state checks are real: digests, barriers, budgets, frozen inputs, CAS bytes and every refusal above. Its role labels are not. `--actor supervisor` is a claim, not authentication, so separation of seats in local mode rests on the operator spawning genuinely separate agents. Local `run.execute` freezes the declared inputs, records the interpreter and import origins, captures stdout, stderr and declared outputs, and **does not contain the process**: it can read the home directory and reach the network. Runs finished this way record `assurance="local-execution"`. Treat that as evidence about the product, not as a sandbox.

**Managed mode is experimental.** The bubblewrap sandbox, the broker, the packet scoping and the JSONL framing are implemented and tested, but no model driver ships in this repository, so a managed deployment requires a transport somebody else has to write. `mp_runtime.reference_driver` is a framing example, not a driver. A host that gives a role parallel unrestricted shell or filesystem tools is running in local mode whatever the configuration says. Do not describe a mission as isolated until `managed probe` has actually passed on the owner host and the driver is known.

Use the complete installed package, not a copied single script. Preserve real ledgers during diagnosis and work on isolated fixtures.
