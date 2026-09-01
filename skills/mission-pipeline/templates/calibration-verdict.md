<!-- mp:header
mission: <Mission>
category: CalibrationVerdict
key: <Mission — aggregate cell | T<n> — task cell>
round: 0
version: <NN>
derives-from: <Charter artifact id>
-->
# Calibration Verdict — <Mission> · <wave <N> | task cell T<n>>

- **Role:** Arbiter (`roles/stabilizer.md`, Arbiter seat) · **Date:** <YYYY-MM-DD> · **Version:** v<NN>
- **Cell:** aggregate (wave boundary) / task (trigger: recovery task | post-amendment spec | PASS at cap | post-compaction spec)
- **Inputs:** engine-fixed via `mp calib bundle` — the PM curated nothing.

## Seat roster
| Seat | Session / model | Hygiene |
|---|---|---|
| Calibrator (starved) | <model, fresh context> | fed nothing beyond its bundle |
| Challenger (fed) | <model, fresh context> | — |
| Arbiter | <model, fresh context> | not any build group's Stabilizer this mission; different model family preferred, never required |

## Accusations
<!-- Only the two legal shapes appear here. Trend must cite mp metrics output;
     contradiction must quote a Charter line. Task cells: contradiction only.
     Anything the Calibrator filed without an anchor goes to Notes below. -->
| # | Shape | Anchor (quoted) | Divergence claimed | Challenger's answer | Arbiter ruling |
|---|---|---|---|---|---|
| 1 | trend / contradiction | "<metric line / Charter line, verbatim>" | <claim> | authorization cited: "<Charter line / amendment v<N> / recorded disposition>" / **conceded** | discharged / undischarged / chain incomplete |

## Verdict
**ALIGNED / SUSPICION / DRIFT** — recorded as a fact: `mp verdict record --kind <verdict>`.

Routing — the engine, not a choice:
- **ALIGNED** → the next wave launches.
- **SUSPICION** → the PM dispositions every incomplete chain (table below). **Consecutive-wave SUSPICION auto-escalates to the principal** — see Ratchet.
- **DRIFT** → the affected fan-out halts; unaffected work continues; the PM presents it to the principal at their next natural appearance, **in goal language, never as machinery**. Task cell: the verdict enters the build loop through the Crititor as an external binding fact (standing-contract grammar) → automatic `CHANGES-REQUESTED`.

## SUSPICION dispositions (PM — mandatory when the verdict is SUSPICION)
| Accusation # | Disposition | Recorded in |
|---|---|---|
| <#> | chain completed — <the located authorization> / accepted risk — <why> / spec change → T<n> | <Integration Note> |

## Ratchet
<!-- Filled from the substrate's verdict record, never from memory. SUSPICION this wave
     AND last wave = fired: the PM MUST present both cells' undischarged items to the
     principal at the next natural appearance. Not a PM option; the ratchet cannot be
     absorbed. -->
- **Previous aggregate verdict:** ALIGNED / SUSPICION / DRIFT / — (first wave)
- **Ratchet fired:** yes / no

## Notes (non-blocking)
<!-- Unanchored unease the Calibrator filed. Never feeds the verdict; the PM reads it. -->
- <note> / None.
