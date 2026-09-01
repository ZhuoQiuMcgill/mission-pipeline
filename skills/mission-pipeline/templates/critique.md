<!-- mp:header
mission: <Mission>
category: Critique
key: T<n>
round: <k>
version: <NN>
derives-from: <TaskSpec artifact id>, <DevReport artifact id>
-->
<!-- IDs in the header come from mp artifact new — never invented. See references/substrate.md. -->
# Critique — T<n>: <Short Name>

- **Mission:** `<Mission>` · **Round:** <k> of <N> · **Version:** v<NN>
- **Role:** Crititor · **Date:** <YYYY-MM-DD>
- **Inputs:** spec `<file>` · mandatory reading <read? list> · report `<file>` · diff <ref/description>

## Verdict
**PASS** / **CHANGES-REQUESTED**

## Criteria table
<!-- Type: R executed command/test (fingerprint-bound) · F frozen-document line (Charter,
     PROJECT.md, contract, amendment) · D mission-era document · X Researcher-verified.
     A "met" on D evidence alone is not met (invariant 13) — mark it partial and name the
     missing R/F anchor. -->
| # | Acceptance criterion | Met? | Type | Evidence |
|---|---|---|---|---|
| 1 | <criterion> | met / partial / missed | R / F / D / X | <test name, `file:line`, quoted frozen line, or command output> |

## Required changes (CHANGES-REQUESTED only)
<!-- Numbered. Each item: what is wrong + what "fixed" looks like. Specific and actionable or it doesn't belong here. -->
1. **<what is wrong>** — fixed looks like: <observable state>.

## Scope & deviation check
- Out-of-scope touches found: <list / none>
- Undeclared deviations found: <list / none>
- Standing-contract violations found: <list / none>
<!-- Any finding = automatic CHANGES-REQUESTED, regardless of code quality. -->

## Out-of-frame risk (mandatory — never feeds the verdict)
<!-- Exactly one item, or "None" with a one-line reason. The one thing that could be wrong
     that neither the spec nor the report mentions. Carried verbatim in the group report;
     the PM must disposition it (engine invariant 11). -->
- <risk and why it matters> / None — <one-line reason the frame looks sound>.

## Notes (non-blocking, optional for the Stabilizer/PM)
- <observation or better-idea-not-required>
