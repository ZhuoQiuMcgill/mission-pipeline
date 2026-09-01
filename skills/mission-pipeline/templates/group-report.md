<!-- mp:header
mission: <Mission>
category: GroupReport
key: T<n>
round: 0
version: <NN>
derives-from: <final DevReport artifact id>, <final Critique artifact id>
-->
<!-- IDs in the header come from mp artifact new — never invented. See references/substrate.md. -->
# Group Report — T<n>: <Short Name>

- **Mission:** `<Mission>` · **Role:** Stabilizer · **Date:** <YYYY-MM-DD> · **Version:** v<NN>

## Outcome
**ACCEPTED** (Crititor PASS, round <k>) / **ESCALATED** (<round cap reached | Constructor blocked>)

## Rounds
| Round | Constructor report | Critique | Verdict | Decision |
|---|---|---|---|---|
| 1 | `DevReport_T<n>_…_v01.md` | `Critique_T<n>_…_v01.md` | <verdict> | <accept / send back / escalate> |

## Evidence spot-check (mandatory before ACCEPTED)
<!-- Judge the evidence chain, not the code: sampled criteria rows — cited file:line exists
     and says what is claimed; cited test/command re-runs green; claimed types are honest —
     a claimed R has its mp evidence row, fingerprint-bound and matching (invariant 13). -->
- Sampled: <n of m criteria rows> · Citations: <real / returned> · Typing: <honest / returned> · Result: **clean** / critique returned for correction (→ v<NN>)

## Flags carried (mandatory, verbatim)
<!-- Every Out-of-frame risk (critiques) and Noticed-but-not-fixed item (reports) of this
     group, quoted verbatim. "None" only if every source section said None. Dropping one
     is a failed group report (engine invariant 11). -->
- "<verbatim flag>" — source: `<file>`

## Final artifacts
- Report: `<ledger>/constructor/<final DevReport>`
- Critique: `<ledger>/critic/<final Critique>`
- Code: <branch / merge ref>

## Escalation (only if escalated)
- **Unmet criteria:** <which acceptance criteria remain unmet>
- **Why stuck:** <the blocking pattern across rounds, or the spec ambiguity verbatim>
- **Options for the PM:** <what a next scoped round / re-spec / re-scope could look like>

## Handoff notes to the PM
<!-- Anything the PM needs for integration: deviations accepted as declared, noticed-but-not-fixed items worth a future task, follow-ups. -->
- <note> / None.
