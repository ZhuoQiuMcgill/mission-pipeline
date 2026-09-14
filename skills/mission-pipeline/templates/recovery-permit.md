# Recovery Permit — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

A permit authorizes bounded repair inside the existing grant while the case's hold stays in force. Two permits per case. It never authorizes ordinary consumption, another case's hold or the close. `seconds` is optional; it defaults to 3600 and is capped at 86400.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "recovery.permit",
  "data": {
    "case": "case-id",
    "tasks": [
      "repair-task-id"
    ],
    "seconds": 3600
  }
}
```
