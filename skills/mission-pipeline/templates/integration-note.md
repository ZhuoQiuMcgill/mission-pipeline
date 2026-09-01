<!-- mp:header
mission: <Mission>
category: IntegrationNote
key: <Mission>
round: 0
version: <NN>
derives-from: <this wave's GroupReport artifact ids>
-->
<!-- IDs in the header come from mp artifact new — never invented. See references/substrate.md. -->
# Integration Note — <Mission>

- **Role:** PM · **Date:** <YYYY-MM-DD> · **Version:** v<NN> · **Scope:** wave <N> / mission close

## Re-grounding (mandatory — every wave boundary)
<!-- Layer L4, the only preventive layer. The PM re-reads the sealed Charter VERBATIM —
     the file, not memory of it — then writes exactly three lines. The PM is the
     longest-lived context and therefore the primary drift source. -->
- **The Charter says:** "<the goal, one line, quoted>"
- **The mission currently pursues:** <one line>
- **Delta:** none / <named — with the written authorization that covers it, or a DRIFT self-report>

**Compaction since last wave:** yes / no
<!-- Mandatory assertion, never omitted. A "yes" arms the task-cell trigger for every
     spec written after it (see SKILL.md, Calibration). -->

## Integrated
| Task | Outcome | Rounds | Merge ref | Notes |
|---|---|---|---|---|
| T1 | accepted / escalated | <k> | <branch / commit> | <one line> |

## Escalation decisions
| Task | Escalation | Decision |
|---|---|---|
| T<n> | <round cap / blocked / spec problem> | re-plan / re-scope / one more scoped round / taken to the principal |

## Flag ledger (mandatory)
<!-- Every flag carried by this wave's group reports — Out-of-frame risks and
     Noticed-but-not-fixed items — each with an explicit disposition.
     Silence is not disposal (engine invariant 11). Presented at sign-off. -->
| Flag (verbatim) | Source | Disposition |
|---|---|---|
| "<flag>" | `<group report>` | accepted risk — <why> / spec change → T<n> / escalated to the principal |

## Footprint reconciliation
<!-- ArchPlan predicted vs actually touched (from dev reports). Deviations inform the next DAG. -->
| Task | Predicted | Actually touched | Delta |
|---|---|---|---|
| T<n> | `<paths>` | `<paths>` | <none / list> |

## Calibration (wave boundaries, missions of ≥2 waves)
<!-- Single-wave mission: write "skipped — single wave; the Auditor and closing gate
     cover close." The cell's inputs were engine-fixed (mp calib bundle); the PM curated
     nothing. -->
- **Aggregate cell verdict:** ALIGNED / SUSPICION / DRIFT — `<CalibrationVerdict file>`
- **Routing applied:** next wave launched / dispositions in the verdict's SUSPICION table / affected fan-out halted → principal (goal language)

## Acts in your name (accumulator — the sign-off repudiation list)
<!-- Every mp command executed on the principal's behalf: Charter amendments,
     ratifications, dispositions the principal decided in conversation. Carried forward
     every wave; presented at sign-off for repudiation item by item (invariant 12).
     An act with no verbatim quote was not authorized. -->
| Act | The principal's verbatim words | Read-back ref | When |
|---|---|---|---|
| <charter amend → v02 / contract ratified / disposition recorded> | "<quote>" | <conversation ref> | <YYYY-MM-DD> |

## Closing gate (mission close only)
<!-- The full-scope verification over the integrated result — engine invariant 10.
     Task-level narrowing never narrows this. Record the run (mp gate record — bound to
     log hash + fingerprint), then close through mp gate close: it refuses on undisposed
     flags, lint failures, or a stale Charter. -->
- Command(s): `<full-scope gate per PROJECT.md>`
- Result: <verbatim summary — counts, failures, skips>
- Log: `<path>` · **Gate record:** <mp gate record ref> · **`mp gate close`:** clean / refused — <reason, escalated>

## Standing-contract candidates
<!-- Entries drafted from this wave's flags, escalations, or failures.
     The principal ratifies at sign-off; ratified entries bind from the next mission. -->
- <draft entry — origin> / None.
