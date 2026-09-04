# Design Doc — Derivation and Supersession (v1.1.0)

- **Category:** DesignDoc · **Date:** 2026-09-04 · **Version:** v01
- **Author:** Zhuo Qiu, with Claude (design session 2026-09-04)
- **Status:** Approved (Zhuo Qiu, 2026-09-04) — released as v1.1.0
- **Supersedes in part:** `DesignDoc_CalibrationAndSubstrate_2026-08-31_v03.md` §6–§7 (the declaration model)

## Revision History

| Date | Version | Change |
|---|---|---|
| 2026-09-04 | v01 | The eleven changes ratified after the first field round, with their mechanisms. |

---

## 1. What the field measured

Three days of 1.0.0 on a real project (5 missions, 77 tasks; the ledger and analysis are
private, aggregate numbers only here):

| Measurement | Value |
|---|---|
| Field journal events | 3296 over 71 active hours |
| Events that were agents copying document facts into the DB | **68.2 %** (80 % with flag carrying) |
| `evidence add` | 1088 calls, 1.99 MB — 73 % of everything typed into `mp` |
| Journal events per artifact | 10.4 (7.1 of them declaration) |
| Sampled critiques whose DB evidence rows still matched their table | 0 of 8 |
| REFUSED events that enforced a real invariant | 4 of 76 (72 were agents fumbling arguments) |
| Round-cap refusals / undisposed-flag-at-close refusals | 0 / 0 (`round open` used on 36 of 76 tasks) |
| Trend-shaped calibration accusations | 2 of 70 (metrics dropped 12 of 77 tasks; the Arbiter refused to trust trends) |
| R evidence rows duplicating another seat's identical run | 230 of 886 (26 %) |
| Lint findings that were lawful | 23 of 23; one close blocked 10 h 44 m |
| Flags whose subject was the ledger, not the product | 61 % of 390 |
| Calibration cells / seat runs / traceable catches | 30 / ~90 / ≥ 6 |

## 2. The essence

**Double-entry.** Truth lived in two places — the markdown and the database — and the
model was the courier between them. organon's principle had been adopted only halfway:
markdown was authoritative, but the index was *declared* by agents, not *derived* from
the documents. Every symptom follows: copying costs tokens (the tax); copies diverge
lawfully (false positives); copying is optional, so invariants attached to the copy bind
no one (the cap never fired); copying by hand introduces errors the tool trusts (a
journal sequence number passed as an id poisoned the journal); and copying demands
attention, so seats wrote about the engine instead of the product.

## 3. The eleven changes and their mechanisms

| # | Change | Mechanism |
|---|---|---|
| 1 | Agents never copy facts into the database | `mp seal <path>` parses the `mp:header` block and the document's structured sections (criteria table, flag sections, verdict lines, amendment ledger, flag ledger, prohibitions, `## Engine relay`) and derives every row. One journal event per artifact carries the full payload. |
| 2 | Rules run where they cannot be skipped | Every rule is a seal refusal, by name: cap, met-needs-R/F, summary-as-root, unknown run/contract/artifact id, wave not open, empty out-of-scope, Charter without amendment row, disposition of an unknown flag, missing required section. |
| 3 | One test run, many citations | `mp run record` identifies a run by (tree hash, command, output hash); a second identical record returns the existing id. Fingerprints bind the judged tree (`--tree`). |
| 4 | Any record can be retired | `mp supersede`; `superseded_by` on every record kind; rules read live records only; dependents surface in `mp worklist` as a to-do for the PM, never an error. |
| 5 | The tool stops making agents think for it | Metrics buckets close (`r_other`); every action validates referenced ids; the write path applies in a savepoint before journaling so an OK line always describes something that happened. |
| 6 | Calibration cheap first | Calibrator alone; zero anchored accusations = ALIGNED, `calibrator-only`; the post-compaction trigger bounded to the window before the next re-grounding and to `touches-contract: yes` specs; `mp calib triggers` computes triggers. |
| 7 | Verdicts have teeth | `mp wave open` is refused under a live DRIFT or two consecutive SUSPICIONs; only `mp supersede verdict --by principal` clears them; engine precedence over project contracts stated. |
| 8 | Paperwork about paperwork leaves the product ledger | `## Engine relay` sections → `mp relay`; flags are about the product only; ledger-subject accusations are out of shape. |
| 9 | Lawful states reported once | Root causes removed (path normalization; Charter special cases gone under re-issue); lint no longer reports staleness. |
| 10 | Charter re-issued, never edited in place | A new file per version; the amendment-ledger row carries the principal's verbatim words; v1 seals prohibitions into standing contracts. |
| 11 | The upstream channel is formal | `mp relay add|list|export` — the deployment's own `engine-relay/` practice adopted. |

## 4. What did not change

Invariants 1–13 (text unchanged). The frozen Charter, the append-only journal and
REFUSED semantics, the three seats' asymmetric feeding, the integration round (PR #2),
the principal-interface principle. These were saving tokens, not spending them.

## 5. Acceptance

Five gates, 168 checks: the seven-mission DIVRA retrospective still reproduces
mechanically (`m1_acceptance`); every evidence rule is refused at seal by name
(`m2_lint`); a whole mission driven by documents alone lands at **2.00 journal events per
artifact** with no declaration verb in the journal (`m3_dryrun`); a 1.0.0 ledger upgrades
in place and its journal replays whole (`m4_migrate`). All nine shipped templates fill,
seal, and lint clean.

## 6. What round 2 must answer

Events per artifact in the field (target: near 2); refusals that bite (cap, wave gate)
versus argument fumbling; cells convened versus calibrator-only, and catches per
convened cell; worklist size after amendments (is the to-do judged, or ignored?);
relay volume versus flag volume (did paperwork leave the product ledger?); whether
the ratchet was ever cleared by the principal rather than absorbed.
