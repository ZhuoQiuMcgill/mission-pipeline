# Dev Report — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

## Acceptance criteria

| # | criterion | status | anchor | type |
|---|---|---|---|---|
| obligation-id | Actual required outcome | met | Current controlled run/delivery id | R |

Use explicit sub-ids and criteria_map for multiple independent rows. Never let a later partial row disappear into an earlier met row.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "report.record",
  "data": {
    "kind": "development",
    "task": "task-id",
    "outcome": "COMPLETE",
    "round": 1,
    "criteria": {
      "obligation-id": "met"
    }
  }
}
```
