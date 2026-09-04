<!-- mp:header
mission: <Mission>
category: Critique
key: T<n>
round: <k>
version: <NN>
derives-from: artifact:<TaskSpec id>, artifact:<DevReport id>
-->
<!-- Seal with one call: python3 <skill>/scripts/mp seal <this file>. The verdict,
     evidence rows, flag, relay items and edges are all derived from the text below;
     nothing is registered by hand. A refusal names the rule the document broke — fix the
     document. See references/substrate.md. -->
# Critique — T<n>: <Short Name>

- **Mission:** `<Mission>` · **Round:** <k> of <N> · **Version:** v<NN>
- **Role:** Crititor · **Date:** <YYYY-MM-DD>
- **Inputs:** spec `<file>` · mandatory reading <read? list> · report `<file>` · diff <ref/description>

## Verdict
**PASS** / **CHANGES-REQUESTED**

## Criteria table
<!-- THIS TABLE IS THE EVIDENCE RECORD — there is no second copy anywhere.
     Met?: met | partial | missed. Type: R → `run:<id>` · F → `charter:v<N>[:<ref>]`,
     `contract:<id>`, `project:<section>` · D → `artifact:<id>[:<section>]` · X → the URL.
     ONE ANCHOR PER ROW: a criterion on three anchors gets three rows repeating the same #.
     The Evidence cell is THE ANCHOR AND NOTHING ELSE — no commentary, no quoted text, no
     trailing dash; what the anchor shows belongs in Required changes or Notes.
     A "met" resting only on D or X is REFUSED at seal (invariant 13) — mark it partial and
     name the missing R or F anchor. Cite run ids from the report's Runs table; re-run only
     to DISPUTE one, recording your own (mp run record) and saying so in Notes. -->
| # | Acceptance criterion | Met? | Evidence | Type |
|---|---|---|---|---|
| 1 | <criterion> | met / partial / missed | `run:<id>` | R |
| 1 | <same criterion, second anchor> | met | `charter:v1:§Prohibitions` | F |

## Required changes
<!-- CHANGES-REQUESTED only. Numbered. Each item: what is wrong + what "fixed" looks like.
     Specific and actionable or it doesn't belong here. -->
1. **<what is wrong>** — fixed looks like: <observable state>.

## Scope & deviation check
- Out-of-scope touches found: <list / none>
- Undeclared deviations found: <list / none>
- Standing-contract violations found: <list / none>
<!-- Any finding = automatic CHANGES-REQUESTED, regardless of code quality. -->

## Out-of-frame risk
<!-- Mandatory; never feeds the verdict. Exactly one bullet, or one starting
     "None — <reason>". The one thing that could be wrong about the PRODUCT or the
     principal's intent that neither the spec nor the report mentions. Derived into the
     flag ledger at seal; the PM must disposition it (engine invariant 11). -->
- <risk and why it matters> / None — <one-line reason the frame looks sound>.

## Engine relay
<!-- Optional. Observations whose subject is the pipeline itself — the engine, the
     ledger, the substrate, another document's bookkeeping. One bullet each, prefixed
     defect: / inefficiency: / suggestion:. Derived at seal, exported upstream; never into
     the product's flag ledger. A flag about a flag belongs here. -->
- inefficiency: <what costs more than it buys, with the artifact ids>

## Notes
<!-- Non-blocking. A better idea neither the criteria nor a written purpose requires. -->
- <observation>
