<!-- mp:header
mission: <Mission>
category: DevReport
key: T<n>
round: <k>
version: <NN>
derives-from: <TaskSpec artifact id>
-->
<!-- IDs in the header come from mp artifact new — never invented. See references/substrate.md. -->
# Implementation Report — T<n>: <Short Name>

- **Mission:** `<Mission>` · **Round:** <k> of <N> · **Version:** v<NN>
- **Role:** Constructor · **Date:** <YYYY-MM-DD>
- **Spec:** `<ledger>/tasks/<TaskSpec file>`

## What was built
<!-- Per requirement, in the spec's numbering. -->
| Req | Status | What was done | Where |
|---|---|---|---|
| 1 | done / partial / not done | <summary> | `file:line` |

## Test evidence
<!-- Every new behavior: the test, and that it failed before / passes after. -->
| Behavior | Test | Fail-before evidence | Pass-after evidence |
|---|---|---|---|
| <behavior> | `test_name` | <output / commit ref> | <output> |

## Verification results
<!-- Before reporting: take the fingerprint (mp fingerprint take), then register one
     evidence row per requirement (mp evidence add --type R --cmd … --output-sha …
     --fingerprint <id>). An R anchor binds the command to the source state that produced
     it — invariant 13. -->
- **Fingerprint:** <id — commit SHA, dirty state> · **Evidence rows:** <registered per requirement / ids>
```
<verbatim output of the spec's verification commands>
```

## Deviations
<!-- Mandatory. Every difference between spec and delivery, however small. Write "None." explicitly if none. -->
- <deviation + why> / None.

## Noticed but not fixed
<!-- Mandatory — write "None." explicitly. Out-of-scope observations for the PM. Not
     changes — observations. Carried verbatim in the group report; the PM must
     disposition each (engine invariant 11). -->
- <observation> / None.

## Files touched
| File | Change |
|---|---|
| `path` | <one line> |

## Round-k changes (rounds ≥ 2 only)
<!-- Map each required change from the critique to what was done about it. -->
| Critique item | Action taken |
|---|---|
| <#> | <what changed> |
