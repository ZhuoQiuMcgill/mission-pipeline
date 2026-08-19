# Integration Note — <Mission>

- **Role:** PM · **Date:** <YYYY-MM-DD> · **Version:** v<NN> · **Scope:** wave <N> / mission close

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

## Closing gate (mission close only)
<!-- The full-scope verification over the integrated result — engine invariant 10.
     Task-level narrowing never narrows this. -->
- Command(s): `<full-scope gate per PROJECT.md>`
- Result: <verbatim summary — counts, failures, skips>
- Log: `<path>`

## Standing-contract candidates
<!-- Entries drafted from this wave's flags, escalations, or failures.
     The principal ratifies at sign-off; ratified entries bind from the next mission. -->
- <draft entry — origin> / None.
