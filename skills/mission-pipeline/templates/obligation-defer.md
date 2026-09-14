# Obligation Defer — schema 4

Read references/runtime-v4.md. Replace every placeholder using current packet ids and actual evidence. Choose the real outcome; a template is not a verdict. For revisions, add the current predecessor's id as `revises`. `seal` snapshots this complete document and supplies its source_blob and stable request id.

## Actual source and reasoning

Describe the original authority, current delivery and concrete evidence read. Preserve true gaps and authorized stage ownership.

A deferral is a disclosed gap with a responsible owner, never a repair, and it needs a grant carrying the defer permission. It is reported in the mission.close outcomes. Store the reason text as its own blob with `blob put` and name that sha256 in reason_blob; sealing this document supplies source_blob, not reason_blob.

## Single risk

- None

## Noticed but not fixed

- None

## Engine relay

- None

```mp-json
{
  "action": "obligation.defer",
  "data": {
    "obligation": "obligation-id",
    "grant": "grant-id",
    "domain": "method",
    "owner": "responsible-owner",
    "reason_blob": "reason-CAS"
  }
}
```
