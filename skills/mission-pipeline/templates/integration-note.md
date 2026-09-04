<!-- mp:header
mission: <Mission>
category: IntegrationNote
key: <Mission>
round: 0
version: <NN>
wave: W<n>
derives-from: <artifact:<this wave's GroupReport ids>, comma-separated>
-->
<!-- Seal with one call: python3 <skill>/scripts/mp seal <this file>. SEALING IT CLOSES
     THE WAVE. Dispositions are derived from the flag ledger table below; one left empty,
     or one naming a flag id that does not exist, is REFUSED (invariant 11). -->
# Integration Note — <Mission> · wave <N>

- **Role:** PM · **Date:** <YYYY-MM-DD> · **Version:** v<NN> · **Scope:** wave <N> / mission close

## Integrated
| Task | Outcome | Rounds | Merge ref | Notes |
|---|---|---|---|---|
| T1 | accepted / escalated | <k> | <branch / commit> | <one line> |

- **Seams this wave:** <the seam contract file and the integration round's result> / none — no group consumed another's output, so no integration round was owed.

## Escalation decisions
| Task | Escalation | Decision |
|---|---|---|
| T<n> | <round cap / blocked / spec problem> | re-plan / re-scope / one more scoped round / taken to the principal |

## Flag ledger
<!-- Every live flag this wave raised, already derived from the documents that raised
     them (`mp status` shows which are still undisposed). Quote each verbatim and give it
     an explicit disposition: silence is not disposal, and an empty one refuses the seal.
     Flags are about the PRODUCT or the principal's intent; an observation about the
     engine, the ledger, or the substrate rides the relay instead (mp relay list / add,
     exported upstream at close). -->
| Flag id | Flag (verbatim) | Source | Disposition |
|---|---|---|---|
| <id> | "<flag>" | `<artifact>` | accepted risk — <why> / spec change → T<n> / escalated to the principal |

## Re-grounding
<!-- Layer L4, the only preventive layer. Re-read the sealed Charter VERBATIM — the file,
     not memory of it — then write exactly these three lines. The PM is the longest-lived
     context and therefore the primary drift source. -->
- **The Charter says:** "<the goal, one line, quoted>"
- **The mission currently pursues:** <one line>
- **Delta:** none / <named — with the written authorization that covers it, or a DRIFT self-report>

## Compaction
<!-- Mandatory assertion, never omitted — exactly one word, `yes` or `no`. A "yes" arms
     the task-cell trigger for every contract-touching spec sealed after the compaction and
     before the next completed re-grounding — `mp calib triggers` reads this line. -->
Compaction since last wave: yes

## Calibration
<!-- The Calibrator runs alone first; a cell with no anchored accusation ends there,
     ALIGNED, convened calibrator-only. Single-wave mission: "skipped — single wave; the
     Auditor and closing gate cover close." Inputs engine-fixed (mp calib bundle). -->
- **Aggregate cell:** ALIGNED / SUSPICION / DRIFT — `<CalibrationVerdict file>` · convened: calibrator-only / full
- **Task cells this wave (`mp calib triggers`):** <T<n> — trigger — verdict> / none triggered
- **Routing applied:** next wave opened / dispositions recorded in the verdict / halted — presented to the principal in goal language

## Acts in your name
<!-- Paste the output of `mp acts --mission <Mission>` — every act executed on the
     principal's behalf (amendments, ratifications, dispositions, a cleared verdict), each
     with their verbatim words. Presented at sign-off for repudiation item by item
     (invariant 12). An act with no verbatim quote was not authorized. -->
```
<mp acts --mission <Mission> output, pasted verbatim>
```

## Footprint reconciliation
<!-- ArchPlan predicted vs actually touched (from dev reports). Deviations inform the next DAG. -->
| Task | Predicted | Actually touched | Delta |
|---|---|---|---|
| T<n> | `<paths>` | `<paths>` | <none / list> |

## Closing gate
<!-- Mission close only. The full-scope verification over the integrated result —
     invariant 10; task-level narrowing never narrows this. Record it with
     `mp run record … --scope closing`; `mp gate close` comes later, on the principal's
     sign-off — it is the act that marks the mission closed. -->
- Command(s): `<full-scope gate per PROJECT.md>`
- **Run:** `run:<id>` · Result: <verbatim summary — counts, failures, skips> · Log: `<path>`
- **`mp gate close`:** clean / refused — <the rule it named, and what was fixed>

## Standing-contract candidates
<!-- Entries drafted from this wave's flags, escalations, or failures. The principal
     ratifies at sign-off; ratified entries bind from the next mission. (A Charter
     prohibition needs no entry here — sealing the Charter ratified it.) -->
- <draft entry — origin> / None.
