"""Machine-readable examples for the installed schema-4 document templates."""
EXAMPLES = {
    "charter": ("root.propose", {"id": "candidate-id", "intake": "intake-id", "goals": ["goal-id"], "contracts": []}),
    "task-spec": ("task.record", {"id": "task-id", "mission": "mission-id", "obligations": ["obligation-id"], "grant": "grant-id", "domain": "method", "effects": ["required-effect"], "allowed_effects": ["required-effect"], "inputs": ["input-CAS"], "write_paths": ["src/product.py"], "outputs": ["result/report.txt"], "dependencies": [], "wave": 1}),
    "dev-report": ("report.record", {"kind": "development", "task": "task-id", "outcome": "COMPLETE", "round": 1, "criteria": {"obligation-id": "met"}}),
    "critique": ("report.record", {"kind": "critique", "task": "task-id", "admission": "admission-id", "outcome": "PASS_OR_CHANGES_REQUESTED", "round": 1, "criteria": {"obligation-id": "met"}}),
    "group-report": ("report.record", {"kind": "acceptance", "task": "task-id", "admission": "admission-id", "critique": "critique-id", "outcome": "ACCEPTED_OR_CHANGES_REQUESTED", "round": 1, "criteria": {"obligation-id": "met"}}),
    "integration-note": ("wave.integrate", {"mission": "mission-id", "number": 1}),
    "calibration-verdict": ("calibration.record", {"bundle": "bundle-id", "wave": 1, "outcome": "ALIGNED_OR_SUSPICION_OR_DRIFT_OR_INPUT_INCOMPLETE"}),
    "closure-audit": ("audit.record", {"bundle": "bundle-id", "outcome": "PASS_OR_FINDINGS_OR_INPUT_INCOMPLETE", "findings": []}),
    "mission-close": ("mission.close", {"mission": "mission-id", "bundle": "bundle-id", "audit": "audit-id", "review": "close-review-id", "closing_run": "run-id", "grant": "grant-id", "domain": "method"}),
    "arch-plan": ("issue.report", {"kind": "ADVISORY", "mission": "mission-id", "text": "Actual producer/dependency/collision findings"}),
    "supervisor-review": ("root.review", {"candidate": "candidate-id", "outcome": "MATCH_OR_MISMATCH_OR_INPUT_INCOMPLETE"}),
    "plan-review": ("plan.review", {"id": "plan-review-id", "plan": "plan-id", "tasks": ["task-id"], "outcome": "PASS_OR_FAIL_OR_INPUT_INCOMPLETE"}),
    "close-review": ("close.review", {"bundle": "bundle-id", "outcome": "PASS_OR_FAIL_OR_INPUT_INCOMPLETE"}),
    "issue-screen": ("issue.screen", {"case": "case-id", "outcome": "ESTABLISHED_OR_DISMISSED"}),
    "case-resolve": ("case.resolve", {"case": "case-id", "outcome": "DISMISSED_OR_VERIFIED_FIXED_OR_AUTHORIZED_EXCEPTION", "repair_tasks": ["repair-task-id"], "counterexample_eliminated": True, "grant": "grant-id", "domain": "method"}),
    "contest-decision": ("contest.decide", {"case": "case-id", "outcome": "DISMISS_ORIGINAL_OR_REPAIR_VERIFIED_OR_AUTHORIZED_EXCEPTION_VERIFIED_OR_UPHOLD_OR_MODIFY_SCOPE_OR_INPUT_INCOMPLETE", "repair_tasks": ["repair-task-id"], "counterexample_eliminated": True, "scope": {"tasks": ["task-id"], "obligations": ["obligation-id"]}, "grant": "grant-id", "domain": "method"}),
    "recovery-permit": ("recovery.permit", {"case": "case-id", "tasks": ["repair-task-id"], "seconds": 3600}),
    "obligation-defer": ("obligation.defer", {"obligation": "obligation-id", "grant": "grant-id", "domain": "method", "owner": "responsible-owner", "reason_blob": "reason-CAS"}),
    "obligation-cancel": ("obligation.cancel", {"obligation": "obligation-id", "grant": "grant-id", "domain": "method", "owner": "responsible-owner", "reason_blob": "reason-CAS"}),
    "legacy-accept": ("legacy.accept", {"mission": "mission-id", "obligation": "obligation-id", "legacy_artifact": "legacy-artifact-id"}),
}

NOTES = {
    "charter": "This is a candidate, not an active root. It creates no principal contract until independently reviewed and atomically activated. Authorized PM choices belong in decision.record.",
    "closure-audit": "List every real mandatory finding in the JSON findings array with source_blob, counterexample_blob, target and affected scope. PASS requires an empty findings array; FINDINGS requires at least one. Missing bundle bytes are INPUT_INCOMPLETE, never an implicit PASS.",
    "supervisor-review": "MATCH binds this exact candidate to this exact authority, and nothing is effective until root.activate. In local mode `seal` fills `contract_scope_digest` from the current contract snapshot and records reading_assurance: self-asserted; read the named contract and authority sources yourself before sealing.",
    "plan-review": "Only PASS admits a task. Record any other honest outcome, for example FAIL or INPUT_INCOMPLETE, to block admission and say why. `tasks` is the exact task list this judgement covers. In local mode `seal` fills `contract_scope_digest` from the current contract snapshot; read the named contract and authority sources yourself before sealing.",
    "close-review": "Read the actual complete bundle, not a summary of it. Outcomes are PASS, FAIL and INPUT_INCOMPLETE; missing bytes are INPUT_INCOMPLETE. Only PASS lets mission.close proceed.",
    "issue-screen": "ESTABLISHED keeps the scoped hold and opens the repair path. DISMISSED ends the case, and an Auditor's case goes to an independent Contest instead of being dismissed here. In local mode `seal` fills `review_basis` from the current review snapshot; read the referenced blobs yourself before sealing.",
    "case-resolve": "Delete the fields that do not belong to your outcome: repair_tasks and counterexample_eliminated belong to VERIFIED_FIXED, grant and domain to AUTHORIZED_EXCEPTION, and DISMISSED carries neither. A leftover placeholder id refuses REVIEW_INPUT_OUTSIDE_SCOPE. Resolution refuses CONTEST_PENDING while a contest is open, and SCREENING_REQUIRED for a dismissal nobody screened. In local mode `seal` fills `review_basis`; read the referenced blobs yourself before sealing.",
    "contest-decision": "This is the independent decision and it applies directly; no Supervisor signs it again. Delete the fields that do not belong to your outcome: repair_tasks and counterexample_eliminated for REPAIR_VERIFIED, scope for MODIFY_SCOPE, which may only narrow the reported scope, grant and domain for AUTHORIZED_EXCEPTION_VERIFIED. INPUT_INCOMPLETE buys one requested supplement, not a second contest. In local mode `seal` fills `review_basis`; read the referenced blobs yourself before sealing.",
    "recovery-permit": "A permit authorizes bounded repair inside the existing grant while the case's hold stays in force. Two permits per case. It never authorizes ordinary consumption, another case's hold or the close. `seconds` is optional; it defaults to 3600 and is capped at 86400.",
    "obligation-defer": "A deferral is a disclosed gap with a responsible owner, never a repair, and it needs a grant carrying the defer permission. It is reported in the mission.close outcomes. Store the reason text as its own blob with `blob put` and name that sha256 in reason_blob; sealing this document supplies source_blob, not reason_blob.",
    "obligation-cancel": "Cancellation withdraws a required outcome under the same defer permission a deferral needs, and records cancelled_by. It is a disclosed gap reported in the mission.close outcomes, not evidence that anything was fixed. Store the reason text as its own blob with `blob put` and name that sha256 in reason_blob; sealing this document supplies source_blob, not reason_blob.",
    "legacy-accept": "One request per obligation already delivered under the adopted legacy mission. It needs the adopted scope, a VERIFIED overlay for the named artifact and a matching acceptance in the adoption plan. The obligation becomes MET with evidence legacy:<artifact> and assurance legacy-recorded: honest history, not a claim that a v4 run happened.",
}


def render(name):
    import json
    action, data = EXAMPLES[name]
    request = {"action": action, "data": data}
    body = "# " + name.replace("-", " ").title() + " — schema 4\n\n"
    body += "Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. "
    body += "Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. "
    body += "`seal` snapshots this complete document and supplies its source_blob and stable request id.\n\n"
    body += "## Actual source and reasoning\n\nDescribe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.\n\n"
    if name in ("dev-report", "critique", "group-report"):
        body += "## Acceptance criteria\n\n| # | criterion | status | anchor | type |\n|---|---|---|---|---|\n| obligation-id | Actual required outcome | met | Current controlled run/delivery id | R |\n\n"
        body += "Use explicit sub-ids and criteria_map for multiple independent rows. Never let a later partial row disappear into an earlier met row.\n\n"
    if name in NOTES:
        body += NOTES[name] + "\n\n"
    body += "## Single risk\n\n- None\n\n## Noticed but not fixed\n\n- None\n\n## Engine relay\n\n- None\n\n"
    body += "```mp-json\n" + json.dumps(request, ensure_ascii=False, indent=2) + "\n```\n"
    return body
