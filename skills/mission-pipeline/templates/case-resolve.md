# Case Resolve — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

Delete the fields that do not belong to your outcome: repair_tasks and counterexample_eliminated belong to VERIFIED_FIXED, grant and domain to AUTHORIZED_EXCEPTION, and DISMISSED carries neither. A leftover placeholder id refuses REVIEW_INPUT_OUTSIDE_SCOPE. Resolution refuses CONTEST_PENDING while a contest is open, and SCREENING_REQUIRED for a dismissal nobody screened. In local mode `seal` fills `review_basis`; read the referenced blobs yourself before sealing.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "case.resolve",
  "data": {
    "case": "case-id",
    "outcome": "DISMISSED_OR_VERIFIED_FIXED_OR_AUTHORIZED_EXCEPTION",
    "repair_tasks": [
      "repair-task-id"
    ],
    "counterexample_eliminated": true,
    "grant": "grant-id",
    "domain": "method"
  }
}
```
