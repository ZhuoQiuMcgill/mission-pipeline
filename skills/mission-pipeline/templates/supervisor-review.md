# Supervisor Review — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

MATCH binds this exact candidate to this exact authority, and nothing is effective until root.activate. In local mode `seal` fills `contract_scope_digest` from the current contract snapshot and records reading_assurance: self-asserted; read the named contract and authority sources yourself before sealing.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "root.review",
  "data": {
    "candidate": "candidate-id",
    "outcome": "MATCH_OR_MISMATCH_OR_INPUT_INCOMPLETE"
  }
}
```
