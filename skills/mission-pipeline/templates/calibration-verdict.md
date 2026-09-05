<!-- mp:header
mission: <Mission>
category: CalibrationVerdict
key: <W<n> aggregate cell | T<n> task cell>
round: 0
version: <NN — in a full cell the Calibrator seals one version and the Arbiter's ruling is the next>
derives-from: <Charter artifact id>
-->
# Calibration Verdict — <Mission> · <wave <N> | task cell T<n>>

- **Date:** <YYYY-MM-DD> · **Version:** v<NN>
- **Cell:** aggregate (wave boundary) / task (trigger: recovery task | post-amendment spec | PASS at cap | post-compaction contract-touching spec)
- **Inputs:** engine-fixed via `mp calib bundle` — the PM curated nothing.
- **Seal:** `python3 <skill>/scripts/mp seal <this file>` — the verdict is derived from the document.

## Convened
<!-- calibrator-only | full. The Calibrator runs ALONE first. No anchored accusation →
     the Calibrator writes this file: `calibrator-only`, an empty accusations table, and
     ALIGNED — a calibrator-only cell has no other verdict. That IS the wave's verdict.
     At least one anchored accusation → `full`, and this file is written TWICE: the
     Calibrator seals its accusation list with the `pending` verdict line below, then the
     PM convenes the Challenger and the Arbiter and the Arbiter seals the NEXT version
     with the ruling, superseding it. -->
**calibrator-only** / **full**

## Seats
| Seat | Session / model | Hygiene |
|---|---|---|
| Calibrator (starved) | <model, fresh context> | fed nothing beyond its bundle |
| Challenger (fed) | <model, fresh context> / — not convened | — |
| Arbiter | <model, fresh context> / — not convened | not any build group's Stabilizer this mission; different model family preferred, never required |

## Accusations
<!-- Only the two legal shapes appear here: trend (must cite mp metrics output) and
     contradiction (must quote a Charter line). Task cells: contradiction only.
     OUT OF SHAPE — and therefore in Notes, not here: anything unanchored, and anything
     whose subject is a ledger artifact (a wrong section label, a stale pointer, a count
     in another document). That is paperwork, not drift in the work.
     calibrator-only cell: leave this table empty. -->
| # | Shape | Anchor (quoted) | Divergence claimed | Challenger's answer | Arbiter ruling |
|---|---|---|---|---|---|
| 1 | trend / contradiction | "<metric line / Charter line, verbatim>" | <claim> | authorization cited: "<Charter line / amendment row / recorded disposition>" / **conceded** | discharged / undischarged / chain incomplete |

## Verdict
**ALIGNED / SUSPICION / DRIFT**

<!-- THE CALIBRATOR'S SEAL IN A FULL CELL: this section's first line reads
     `pending — Challenger and Arbiter convened`
     and nothing else changes. That seal derives the accusations' evidence rows and any
     relay items at once — none of the starved seat's work waits on seats nobody has
     convened yet — and records NO verdict. The Arbiter's version supersedes it. -->

Routing — the engine, not a choice:
- **ALIGNED** → the next wave opens.
- **SUSPICION** → the PM dispositions every incomplete chain below. Two consecutive SUSPICIONs are the ratchet: **`mp wave open` refuses** until the principal clears it.
- **DRIFT** → **`mp wave open` refuses**; the affected fan-out is halted mechanically, unaffected work continues, and the PM presents it to the principal at their next natural appearance, **in goal language, never as machinery**. Task cell: the verdict enters the build loop through the Crititor as an external binding fact (standing-contract grammar) → automatic `CHANGES-REQUESTED`.

Only the principal lifts a halt or a ratchet — `mp supersede verdict:<id> --by principal --reason "<their verbatim words>"`, executed by the PM on their word. **No standing contract or project rule overrides this.**

## Disposition
<!-- PM, and only when the verdict is SUSPICION. One row per incomplete chain. -->
| Accusation # | Disposition | Recorded in |
|---|---|---|
| <#> | chain completed — <the located authorization> / accepted risk — <why> / spec change → T<n> | <Integration Note> |

## Notes
<!-- Unanchored unease, and every out-of-shape observation. Never feeds the verdict; the
     PM reads it. An observation about the engine, this ledger, or the substrate belongs
     upstream: mark the note `defect:` / `inefficiency:` / `suggestion:` and the PM relays
     it with `mp relay add`. -->
- <note> / None.
