# Calibration Verdict — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "calibration.record",
  "data": {
    "bundle": "bundle-id",
    "wave": 1,
    "outcome": "ALIGNED_OR_SUSPICION_OR_DRIFT_OR_INPUT_INCOMPLETE"
  }
}
```
