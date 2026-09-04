<!-- mp:header
mission: <Mission>
category: GroupReport
key: T<n>
round: 0
version: <NN>
derives-from: artifact:<final DevReport id>, artifact:<final Critique id>
-->
<!-- Seal with one call: python3 <skill>/scripts/mp seal <this file>. There is NO flag
     section — every Out-of-frame risk and Noticed-but-not-fixed item entered the flag
     ledger when its own document sealed, and the PM dispositions each by id. Nothing
     travels by re-typing. -->
# Group Report — T<n>: <Short Name>

- **Mission:** `<Mission>` · **Role:** Stabilizer · **Date:** <YYYY-MM-DD> · **Version:** v<NN>

## Outcome
**ACCEPTED** (Crititor PASS, round <k>) / **ESCALATED** (<round cap reached | Constructor blocked>)

## Rounds
| Round | Constructor report | Critique | Verdict | Decision |
|---|---|---|---|---|
| 1 | `DevReport_T<n>_…_v01.md` | `Critique_T<n>_…_v01.md` | <verdict> | <accept / send back / escalate> |

## Evidence spot-check
<!-- Mandatory before ACCEPTED. The engine already checked that every anchor RESOLVES —
     the seal refused the critique otherwise. Your half: does the cited thing SAY WHAT IS
     CLAIMED — the file:line show that behaviour, the run's log that result over the tree
     the task was built in, the quoted contract line mean what the row uses it to mean.
     Judge the evidence chain, not the code. -->
- Sampled: <n of m criteria rows> · Read: <which anchors you opened> · Says what is claimed: <yes / row <#> returned> · Result: **clean** / critique returned for correction (→ v<NN>)

## Final artifacts
- Report: `<ledger>/constructor/<final DevReport>`
- Critique: `<ledger>/critic/<final Critique>`
- Code: <branch / merge ref>

## Escalation
<!-- Only if escalated; otherwise "None." -->
- **Unmet criteria:** <which acceptance criteria remain unmet>
- **Why stuck:** <the blocking pattern across rounds, or the spec ambiguity verbatim>
- **Options for the PM:** <what a next scoped round / re-spec / re-scope could look like>

## Handoff notes
<!-- Anything the PM needs for integration: deviations accepted as declared, follow-ups,
     and any flag that changed your judgement of the task (the flag itself travels on its
     own — say only what it changed here). -->
- <note> / None.
