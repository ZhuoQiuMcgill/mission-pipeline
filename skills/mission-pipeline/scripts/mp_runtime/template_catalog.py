"""Machine-readable examples for the installed schema-4 document templates."""
EXAMPLES = {
    "charter": ("root.propose", {"id": "candidate-id", "intake": "intake-id", "goals": ["goal-id"], "contracts": []}),
    "task-spec": ("task.record", {"id": "task-id", "mission": "mission-id", "obligations": ["obligation-id"], "grant": "grant-id", "domain": "method", "effects": ["required-effect"], "allowed_effects": ["required-effect"], "inputs": ["input-CAS"], "write_paths": ["src/product.py"], "outputs": ["result/report.txt"], "dependencies": [], "wave": 1}),
    "dev-report": ("report.record", {"kind": "development", "task": "task-id", "outcome": "COMPLETE", "round": 1, "criteria": {"obligation-id": "met"}}),
    "critique": ("report.record", {"kind": "critique", "task": "task-id", "admission": "admission-id", "outcome": "PASS_OR_CHANGES_REQUESTED", "round": 1, "criteria": {"obligation-id": "met"}}),
    "group-report": ("report.record", {"kind": "acceptance", "task": "task-id", "admission": "admission-id", "critique": "critique-id", "outcome": "ACCEPTED_OR_CHANGES_REQUESTED", "round": 1, "criteria": {"obligation-id": "met"}}),
    "integration-note": ("wave.integrate", {"mission": "mission-id", "number": 1}),
    "calibration-verdict": ("calibration.record", {"bundle": "bundle-id", "wave": 1, "outcome": "ALIGNED_OR_SUSPICION_OR_DRIFT_OR_INPUT_INCOMPLETE"}),
    "closure-audit": ("audit.record", {"bundle": "bundle-id", "findings": []}),
    "mission-close": ("mission.close", {"mission": "mission-id", "bundle": "bundle-id", "audit": "audit-id", "review": "close-review-id", "closing_run": "run-id", "grant": "grant-id", "domain": "method"}),
    "arch-plan": ("issue.report", {"kind": "ADVISORY", "mission": "mission-id", "text": "Actual producer/dependency/collision findings"}),
    "supervisor-review": ("root.review", {"candidate": "candidate-id", "outcome": "MATCH_OR_MISMATCH_OR_INPUT_INCOMPLETE"}),
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
    if name == "closure-audit":
        body += "List every real mandatory finding in the JSON findings array with source_blob, counterexample_blob, target and affected scope. Empty findings means the actual complete read found no mandatory gap.\n\n"
    if name == "charter":
        body += "This is a candidate, not an active root. It creates no principal contract until independently reviewed and atomically activated. Authorized PM choices belong in decision.record.\n\n"
    body += "## Single risk\n\n- None\n\n## Noticed but not fixed\n\n- None\n\n## Engine relay\n\n- None\n\n"
    body += "```mp-json\n" + json.dumps(request, ensure_ascii=False, indent=2) + "\n```\n"
    return body
