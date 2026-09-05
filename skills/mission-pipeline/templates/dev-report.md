<!-- mp:header
mission: <Mission>
category: DevReport
key: T<n>
round: <k>
version: <NN>
derives-from: artifact:<TaskSpec id>
-->
<!-- Seal with one call: python3 <skill>/scripts/mp seal <this file>. Every record
     (runs cited, flags, edges, round) is derived from the text below; nothing is registered
     by hand. A refusal names the rule the document broke — fix the document.
     See references/substrate.md. -->
# Implementation Report — T<n>: <Short Name>

- **Mission:** `<Mission>` · **Round:** <k> of <N> · **Version:** v<NN>
- **Role:** Constructor · **Date:** <YYYY-MM-DD>
- **Spec:** `<ledger>/tasks/<TaskSpec file>`

## What was built
<!-- Per requirement, in the spec's numbering. -->
| Req | Status | What was done | Where |
|---|---|---|---|
| 1 | done / partial / not done | <summary> | `file:line` |

## Runs
<!-- One row per verification you executed and recorded:
     mp run record --cmd "<command>" --log <file> --result pass|fail|mixed [--tree <worktree>]
     --result on EVERY call: the row, not the log, is what a later seat reads.
     --tree whenever you built in a worktree: the run binds to the tree it judged, not the
     mission tip. --expect fail marks a deliberate fail-before batch — never a passing
     anchor. --commit <sha> when the tree has already moved since the execution (declared,
     not measured — record immediately when you can). A multi-step verification is a
     script: record the SCRIPT PATH as the command and the engine hashes the script, so
     the exact thing you ran can be re-run. Every seat downstream cites these ids. -->
| Run | Command | Result |
|---|---|---|
| `run:<id>` | `<command>` | <pass / fail — counts, failures, skips> |

## Verification results
<!-- The fail-before / pass-after evidence for every new behaviour, plus any output
     worth reading inline. Cite the run id; its log is already bound to it. -->
| Behavior | Test | Fail-before evidence | Pass-after evidence |
|---|---|---|---|
| <behavior> | `test_name` | <output / commit ref> | `run:<id>` |

```
<verbatim output worth reading inline>
```

## Deviations
<!-- Mandatory. Every difference between spec and delivery, however small. Write "None." explicitly if none. -->
- <deviation + why> / None.

## Noticed but not fixed
<!-- Mandatory — write "None." explicitly. Out-of-scope observations about the PRODUCT
     or the principal's intent; observations, not changes. Derived into the flag ledger at
     seal; the PM dispositions each (invariant 11). An observation about the engine, the
     ledger, or `mp` is NOT a flag — see below.
     RE-ISSUE: this section RECONCILES against the previous version's flags by text — an
     unchanged bullet keeps its flag id and its disposition. Say so outright, and a carried
     bullet then creates no flag at all. Never write "round 1's flags still stand": that is
     a bullet, so it becomes a flag about flags. -->
- <observation> / - carried: flag:<id> / - carried: <the flag's text> / None.

## Engine relay
<!-- Optional. Observations whose subject is the pipeline itself — the engine, the
     ledger, the substrate. One bullet each, prefixed defect: / inefficiency: /
     suggestion:. Derived at seal, exported upstream; never into the flag ledger. -->
- defect: <what broke, and how to reproduce it>

## Files touched
| File | Change |
|---|---|
| `path` | <one line> |

## Round-k changes
<!-- Rounds ≥ 2 only. Map each required change from the critique to what was done about it. -->
| Critique item | Action taken |
|---|---|
| <#> | <what changed> |
