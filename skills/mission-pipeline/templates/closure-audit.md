# Closure Audit — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

List every real mandatory finding in the JSON findings array with source_blob, counterexample_blob, target and affected scope. Empty findings means the actual complete read found no mandatory gap.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "audit.record",
  "data": {
    "bundle": "bundle-id",
    "findings": []
  }
}
```
