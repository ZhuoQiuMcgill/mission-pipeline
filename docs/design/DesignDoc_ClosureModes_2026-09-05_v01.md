# Design Doc — Closure Modes and the Derived Lifecycle (v1.2.0)

- **Category:** DesignDoc · **Date:** 2026-09-05 · **Version:** v01
- **Author:** Zhuo Qiu, with Claude (design session 2026-09-05)
- **Status:** Approved (Zhuo Qiu, 2026-09-05) — released as v1.2.0
- **Amends:** invariant 9 (see §3); `DesignDoc_DerivationAndSupersession_2026-09-04_v01.md` §3 items 1–2 extended to the mission lifecycle

## Revision History

| Date | Version | Change |
|---|---|---|
| 2026-09-05 | v01 | The principal's ruling after field PR #4: two closure modes, the lifecycle derived from documents, and the defect classes the field's 29 relay items proved. |

---

## 1. What the field showed

Two days of 1.1.0 on the same deployment (field PR #4): the PM stalled for several
hours at a mission boundary with everything prepared and nothing blocking on substance.
Four things combined — `mp lint` re-checked 1.0.0-sealed documents against the 1.1
contract (163 false findings; the close refuses on any); the harness's permission
classifier blocked `mp mission claim` and `mp mission close` while every other verb
had run for days unprompted; the engine's text told the harness a human belongs at the
boundary; and the deployment's ratified delegation (its standing contract #1: the PM
closes without per-mission sign-off, the principal repudiates from `mp acts`) was
something the engine could not read.

The deployment's relay queue (29 items) added the defect classes: a 17-item residue
list re-derived across three document versions produced 52 flags and 77 undisposed
items; a run recorded a tree the execution had not judged; a closing record of an
identical output was refused because scope was not part of a run's identity; a
Calibrator in a full cell could not seal its accusation list; migrated ledgers carried
1.0.0-lawful in-place Charter amendments that doctor reported as tampering forever.

## 2. The ruling

**Two closure modes, declared once by the principal — like a harness's permission modes.**

| | sign-off (default) | auto |
|---|---|---|
| Who closes | the principal, in person | the PM, when the gate conditions hold |
| The principal's part | accepts each mission | none during the mission; repudiates item by item from `mp acts`; a repudiation reopens the mission |
| What still stops in both modes | DRIFT halt · SUSPICION ratchet · Charter amendment | the same |

Auto mode removes every *procedural* human dependency and keeps every *substantive*
one. The field's stall was procedural end to end.

## 3. Invariant 9, amended

> **9. The principal closes the mission** — in person (sign-off mode), or by standing
> delegation with item-by-item repudiation (auto mode). The mode is the principal's
> declaration in PROJECT.md; the PM never chooses it. Integration and reporting do not
> close a mission.

Invariant 10's "reaches sign-off" became "closes" — wording only. All other invariants
are unchanged.

## 4. Mechanisms

| Change | Mechanism |
|---|---|
| Lifecycle derived | Sealing a Charter v1 claims the mission; sealing a **MissionClose** note closes it. The note's seal refuses, naming every failing condition at once: an undisposed flag, a lint finding in this mission, a missing or drifted closing run, a missing Closure Audit while the audit is on, no sealed Charter, and — per mode — missing acceptance words or a missing live delegating contract. No lifecycle verb remains for a classifier to single out (`mission claim/close` deprecated, `gate close` retired). |
| Repudiation | `mp supersede mission:<name> --by principal --reason "<verbatim>"` reopens; the act and every closure in auto mode appear in `mp acts`. |
| Configuration | `mp config set closure sign-off\|auto`, `mp config set audit on\|off` — on the principal's word, `--quote` carried, listed in `mp acts`. |
| Re-issue reconciliation | A new version supersedes every record the old one derived, except flags, which are reconciled by text (same text → same id, disposition kept); `- carried: flag:<id>` carries explicitly. |
| Runs | `--result`, `--expect fail`, `--commit <sha>` (declared binding), script hash, scope in identity, git tree id beside the fingerprint; `run list\|show`. |
| Calibration | A full cell's Calibrator seals its accusation list as a `pending` verdict; the Arbiter's version supersedes it. |
| Migration | schema v3; `mp migrate --repair` re-stamps 1.0.0 in-place Charters, marks adopted artifacts prose-only, backfills one wave per mission. |
| Permission note | `init` may, with the principal's one-sentence consent, allow the substrate command in the project's harness settings. |

## 5. Acceptance

Eight gates, all green: the seven-mission retrospective still reproduces; every
evidence rule refused at seal; the document-driven dry run (three consecutive runs —
the timing flake PR #4 found is gone); v1→v3 and v2→v3 migration with `--repair`;
both closure modes end to end including refusals and a repudiation; the 17-item
residue list surviving three versions as 17 flags; the run row's new facts. All ten
templates fill, seal, and lint clean.

## 6. What round 3 must answer

Whether any mission stalled on procedure at all; how many closures were repudiated
and why; live flags per residue item (target 1.0); cells convened versus pending
seals; whether `--expect fail` and `--commit` runs appear where they should.
