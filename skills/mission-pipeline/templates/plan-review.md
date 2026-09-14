# Plan Review — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

Only PASS admits a task. Record any other honest outcome, for example FAIL or INPUT_INCOMPLETE, to block admission and say why. `tasks` is the exact task list this judgement covers. In local mode `seal` fills `contract_scope_digest` from the current contract snapshot; read the named contract and authority sources yourself before sealing.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "plan.review",
  "data": {
    "id": "plan-review-id",
    "plan": "plan-id",
    "tasks": [
      "task-id"
    ],
    "outcome": "PASS_OR_FAIL_OR_INPUT_INCOMPLETE"
  }
}
```
