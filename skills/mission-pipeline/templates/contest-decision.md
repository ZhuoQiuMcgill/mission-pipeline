# Contest Decision — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

This is the independent decision and it applies directly; no Supervisor signs it again. Delete the fields that do not belong to your outcome: repair_tasks and counterexample_eliminated for REPAIR_VERIFIED, scope for MODIFY_SCOPE, which may only narrow the reported scope, grant and domain for AUTHORIZED_EXCEPTION_VERIFIED. INPUT_INCOMPLETE buys one requested supplement, not a second contest. In local mode `seal` fills `review_basis`; read the referenced blobs yourself before sealing.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "contest.decide",
  "data": {
    "case": "case-id",
    "outcome": "DISMISS_ORIGINAL_OR_REPAIR_VERIFIED_OR_AUTHORIZED_EXCEPTION_VERIFIED_OR_UPHOLD_OR_MODIFY_SCOPE_OR_INPUT_INCOMPLETE",
    "repair_tasks": [
      "repair-task-id"
    ],
    "counterexample_eliminated": true,
    "scope": {
      "tasks": [
        "task-id"
      ],
      "obligations": [
        "obligation-id"
      ]
    },
    "grant": "grant-id",
    "domain": "method"
  }
}
```
