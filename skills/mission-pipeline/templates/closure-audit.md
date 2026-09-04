<!-- mp:header
mission: <Mission>
category: ClosureAudit
key: <Mission>
round: 0
version: <NN>
derives-from: artifact:<DesignDoc id>, artifact:<final IntegrationNote id>
-->
<!-- Seal with one call: python3 <skill>/scripts/mp seal <this file>. -->
# Closure Audit — <Mission>

- **Role:** Auditor · **Date:** <YYYY-MM-DD> · **Version:** v<NN>
- **Model family:** <different from the working seats when available; otherwise the same model in a fresh session>
- **Inputs:** design decision `<file>` · Integration Note `<file>` · the closing gate's `run:<id>` (command, log, and the tree it judged) · standing contracts · group reports <as needed>

## The question
Does the integrated result deliver the design decision's stated goal?

## Goal → delivered
<!-- Quote the goal, element by element. Evidence, not narrative. -->
| Goal element (quoted from the design decision) | Delivered? | Evidence |
|---|---|---|
| "<quoted line>" | yes / partial / no | `run:<id>`, artifact, gate line, or observed behavior |

## Frame risks
<!-- What the mission's frame itself may have missed — assumptions every seat shared,
     identities or contracts nothing verifies, evidence that proves less than it appears to. -->
- <risk + evidence> / None found.

## Advisory verdict
**DELIVERS / DELIVERS WITH GAPS / DOES NOT DELIVER** — <one line>
<!-- Advisory: the principal judges. This feeds sign-off; it does not replace it. -->
