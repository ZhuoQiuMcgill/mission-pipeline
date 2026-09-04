# The Substrate — deterministic state under the paper

`mp` is the pipeline's state tool: one stdlib-only Python script (this skill's `scripts/mp`) that owns every state transition. Judgment stays in prose; determinism lives here; derived state is disposable.

**Agent-internal only — invariant 12: the principal converses; agents operate.** `mp` never appears in anything the principal is asked to do; no pipeline step may require the principal to run it. Invoke it as:

```bash
python3 <absolute path to skill>/scripts/mp <command> …
```

Attribute every call: `--actor <role[:task]>` (e.g. `--actor stabilizer:T7`) or the `MP_ACTOR` environment variable. Python ≥ 3.8, stdlib only; `mp doctor` fails init loudly if the environment cannot support it — never mid-mission.

## Derive, don't declare — the one rule

**Agents write documents. The engine derives the records.** Write your artifact once, then submit it with a single call — `python3 <skill>/scripts/mp seal <absolute path>` — and `mp` derives everything the ledger holds: the artifact and its id (the `mp:header` block), evidence rows (the criteria table), flags (Out-of-frame and Noticed-but-not-fixed), verdicts (the verdict line), the round, the edges (`derives-from`), dispositions (an Integration Note's flag ledger), relay items (`## Engine relay`). Nothing is typed twice, so nothing in the ledger can disagree with the document it came from.

Only two commands still take a fact the document cannot contain, because it happened outside the text: `mp run record` (an execution happened, over this tree) and `mp supersede` (this record no longer stands). Everything else is a read.

## The document contract

Every artifact opens with this block, inside its first 40 lines:

```
<!-- mp:header
mission: <mission name>
category: <TaskSpec|DevReport|Critique|GroupReport|ArchPlan|DesignDoc|IntegrationNote|ClosureAudit|Charter|CalibrationVerdict|ResearchRequest|ResearchResult|ResearchTrail>
key: <T<n> task-scoped | mission name | W<n> aggregate CalibrationVerdict | topic>
round: <int; 0 when not round-scoped>
version: <int>
wave: <W<n>>                      # REQUIRED on TaskSpec and IntegrationNote
recovers: <T<n>>                  # TaskSpec only, optional
touches-contract: <yes|no>        # TaskSpec only, REQUIRED
derives-from: <artifact:<id> | <ledger-relative path> | none, comma-separated>
-->
```

Headings are `##` and exact; table header rows are exact. The templates are this contract's human face — write from them, not from memory.

| Category | Sections the parser reads |
|---|---|
| **Critique** | `## Verdict` (PASS / CHANGES-REQUESTED on the first line) · `## Criteria table` — header `\| # \| Acceptance criterion \| Met? \| Evidence \| Type \|` · `## Required changes` · `## Scope & deviation check` · `## Out-of-frame risk` · `## Engine relay` (optional) · `## Notes` |
| **DevReport** | `## What was built` · `## Runs` — header `\| Run \| Command \| Result \|` · `## Verification results` · `## Deviations` · `## Noticed but not fixed` · `## Engine relay` (optional) · `## Files touched` · `## Round-k changes` |
| **GroupReport** | `## Outcome` (ACCEPTED / ESCALATED on the first line) · `## Rounds` · `## Evidence spot-check` · `## Final artifacts` · `## Escalation` · `## Handoff notes` |
| **CalibrationVerdict** | `## Convened` (`calibrator-only` \| `full`) · `## Seats` · `## Accusations` · `## Verdict` (ALIGNED / SUSPICION / DRIFT on the first line) · `## Disposition` (SUSPICION only) · `## Notes` |
| **IntegrationNote** | `## Integrated` · `## Escalation decisions` · `## Flag ledger` — header `\| Flag id \| Flag (verbatim) \| Source \| Disposition \|` · `## Re-grounding` · `## Compaction` (contains the line `Compaction since last wave: yes\|no`) · `## Calibration` · `## Acts in your name` · `## Footprint reconciliation` · `## Closing gate` · `## Standing-contract candidates` |
| **Charter** | `## The principal's own words` · `## Confirmed read-backs` · `## Prohibitions` (bullets → standing contracts at seal) · `## Priorities and tradeoffs` · `## Amendment ledger` — header `\| Version \| Date \| Principal's words (verbatim) \| Read-back ref \|`, one row per version ≥ 2 |
| **TaskSpec** | header `wave` and `touches-contract` required · `## Out of scope — do NOT` with ≥ 1 real bullet |
| Everything else | the header block only |

**Criteria rows.** `Met?` is `met` / `partial` / `missed`; `Type` is `R` / `F` / `D` / `X`; **one anchor per row** — a criterion resting on three anchors gets three rows repeating the same `#`. **The Evidence cell is the anchor and nothing else** (`run:7`, not `run:7 — the suite is green`); what the anchor shows belongs in the prose sections.

## The rules run at seal

Sealing is the one step nobody can skip, so that is where the rules are. Each of these **refuses** the seal, naming the rule:

| Refused | Because |
|---|---|
| a round past the cap | invariant 4 — bounded rounds |
| a "met" resting only on D or X evidence | invariant 13 — echoes are not evidence |
| an **R** anchor to a `run:<id>` that does not exist | reality anchors bind to a recorded execution |
| a **D** anchor pointing at a GroupReport or Integration Note | summaries are never citable roots (rule 5) |
| a `charter:v<N>` anchor with no such version | fixed points must be fixed |
| a TaskSpec whose wave is not open, or whose out-of-scope is empty | waves carry the calibration teeth; invariant 5 |
| a Charter v*N* without its amendment row | an amendment is the principal's words or it is not an amendment |
| an Integration Note disposing an unknown flag, or leaving a disposition empty | invariant 11 — silence is not disposal |
| an unresolvable `derives-from`, an anchor to an unknown `run:` / `contract:` / `artifact:` id, or a missing header field | the document must say where it came from — a made-up id was how the field's journal got poisoned |
| a required section missing (Critique: Verdict, Criteria table, Out-of-frame risk · DevReport: Runs, Noticed but not fixed · Integration Note: Flag ledger, Compaction · GroupReport: Outcome · CalibrationVerdict: Verdict, Convened · TaskSpec: Out of scope) | the parser derives from these; a "None" bullet satisfies a flag section |

**REFUSED is the engine speaking**, and the refusal is journaled like any other event. Fix the **document** and seal again. **Never route around a refusal:** no retry with altered arguments to make it pass, no hand-edit to the same effect, no re-plan around a halt. A refusal you believe is wrong is an engine defect — put it under `## Engine relay` and escalate up the ladder (Constructor/Crititor → Stabilizer → PM → principal) with the refusal line quoted verbatim.

## Runs — verification is a shared fact

`mp run record --cmd "<command>" --log <file> [--tree <worktree path>]` returns `run:<id>`; add `--scope closing` for the closing-gate run. **Whoever executes a verification records it once; every other seat cites the id.** The run binds to the **tree it judged** — pass `--tree` in a worktree — and fingerprints that tree itself, so no separate `mp fingerprint take` is needed. Re-run only to **dispute** a run; then record your own and say what it disputes. Five seats re-running one suite because none can trust another's run is the cost this replaces.

## Supersession — every record can be retired

`mp supersede <kind>:<id> --by <kind>:<id>|principal|reality --reason "…"`.

- Sealing a new version of a document supersedes the previous version's records automatically.
- `--by principal` is the only way a calibration verdict is cleared; the reason carries the principal's verbatim words and the act appears in `mp acts`. `--by reality` retires what a later run disproved.
- **Rules read live records only.** A superseded record stays in the journal as history and stops binding anything.
- Whatever depended on a superseded record appears in **`mp worklist`** — a to-do for the PM to judge (*does this change matter to that judgement?*), **never an error**, and never an automatic re-issue.

## Three layers, one write path

| Layer | File | Authority |
|---|---|---|
| Event journal | `ledger/events.jsonl` | **authoritative for every state transition — including refusals.** Append-only; history physically unrewritable. |
| SQLite | `ledger/mp.db` | derived, operational — rebuildable by replay (`mp rebuild`); disposable. |
| Markdown | the ledger's artifacts | **authoritative for judgment** — and now for the records too: every row is derived from a document. |

Every state change appends the journal line first (fsync), then applies it to the DB, under a lock. **Never write the DB directly** — `mp doctor` replays the journal against the DB and reports divergence, so a bypass is detected, not debated.

## Command surface

| Command | When |
|---|---|
| `mp init` | once, at setup — creates the substrate (dirs, DB, journal) |
| `mp doctor` | health: environment, journal/DB divergence, seal integrity — at setup, and whenever anything looks off |
| `mp rebuild` | rebuild `mp.db` by replaying the journal — after DB loss or doctor divergence |
| `mp migrate` | upgrade the schema after an engine upgrade — including a v1.0.0 ledger moving to this release |
| `mp status` | orientation: missions, open waves, undisposed flags, journal seq |
| `mp mission claim` / `close` | atomic claim at kickoff (it derives the `MISSIONS.md` line). `close` is what `mp gate close` performs on the principal's sign-off — calling it directly skips the gate's checks |
| `mp wave open W<n> --mission <name> --tasks T4,T5,…` / `close` | open before **every** fan-out, single-wave missions included; the wave declares its task set. **Refuses while a DRIFT stands or two consecutive SUSPICIONs stand.** Sealing the wave's Integration Note closes it; `close` by hand is for a wave abandoned without one |
| `mp seal <path>` | the write path for documents — parses, derives every record, runs the rules |
| `mp run record` | `--cmd` · `--log` · `--tree` (worktrees) · `--scope closing` (the closing-gate run) → `run:<id>`; the shared verification fact |
| `mp supersede <kind>:<id>` | retire a record — kinds `artifact` · `verdict` · `flag` · `evidence` · `charter` · `contract` · `run`; `--by <kind>:<id>` / `principal` / `reality`, with a `--reason` |
| `mp worklist` | what still depends on something superseded — the PM's to-do, not an error |
| `mp acts --mission <name>` | the acts executed in the principal's name; pasted into the Integration Note, presented as the repudiation list at sign-off |
| `mp relay add --kind defect\|inefficiency\|suggestion --text …` / `list` / `export` | the engine relay: file, read, and export observations about the pipeline itself |
| `mp calib triggers` | which tasks earned a task-level cell — computed, not remembered |
| `mp calib check` | the standing verdict state: a DRIFT halt, a fired ratchet |
| `mp calib bundle --seat calibrator\|challenger` | rule-derived calibration inputs — the PM cannot curate |
| `mp metrics` | mechanical cross-wave metrics — the only legal source for a trend claim |
| `mp lint` | evidence-law mechanics over **live** records: header consistency · D-only chains · summaries cited as roots · stale Charter anchors and superseded citations · R rows whose run no longer matches its tree |
| `mp gate close` | the hardened close, run **on the principal's sign-off**: Charter sealed and current · every flag disposed · a closing run recorded (`--scope closing`) over the integrated tree · that tree still matching (fail closed on source drift) · zero lint findings. All five pass → the mission is marked closed |
| `mp contract add` | a ratification that is not a Charter prohibition — those ratify themselves when the Charter seals |
| `mp adopt` | import a v0.3-era prose ledger, once, at migration |

**Deprecated compatibility aliases.** `mp artifact new` · `artifact seal` · `evidence add` · `edge add` · `flag add` · `flag dispose` · `round open` / `close` · `verdict record` · `charter seal` / `amend` · `gate record` are all superseded by `mp seal` and `mp run record`. They survive only so a v1.0.0 ledger keeps replaying. **Do not use them in any new work**; nothing in the roles or templates calls them.

## Evidence law

Every criteria row in a verdict-bearing artifact carries one type and one anchor:

| Type | Root | Anchor form |
|---|---|---|
| **R** | reality — a recorded execution | `run:<id>` |
| **F** | fixed point — frozen before the mission web | `charter:v<N>[:<ref>]` · `contract:<id>` · `project:<section>` |
| **D** | derived — any mission-era document | `artifact:<id>[:<section>]` |
| **X** | external — a source the Researcher actually fetched and verified | the verified URL; unverified sources are leads, never anchors |

The six rules:

1. **D+D agreement = zero weight.** Corroboration counts distinct roots, not documents.
2. **Every criterion marked "met" needs ≥1 R or F anchor.** A verdict resting only on D is structurally circular — refused at seal, no judgment required.
3. **D never upgrades.** A D-only claim gains no confidence by being cited more.
4. **R binds to source state.** A run binds to the tree it judged; verification fails closed on mismatch.
5. **Summaries are never citable roots.** Cite the underlying artifact a summary carries — the generalization of "flags travel verbatim."
6. **Stale citations are flagged.** Citing a superseded version is a lint finding over live records; a new Charter version propagates staleness.

This is invariant 13 operationalized: *echoes are not evidence.*

## Engine relay — where paperwork-about-paperwork goes

An observation whose subject is the **engine, the ledger, or the substrate** is not a flag and not an accusation. It goes in the document's `## Engine relay` section — one bullet each, prefixed `defect:` / `inefficiency:` / `suggestion:` — and is derived at seal; the PM reads them with `mp relay list` and sends them upstream with `mp relay export` at close. Flags stay about the **product** or the principal's intent; a flag about another flag's count is a relay item.

## Who runs what

| Actor | Commands |
|---|---|
| Constructor | `run record` (per verification, `--tree` in a worktree) · `seal` (its report) |
| Crititor | `seal` (its critique) — and `run record` only when disputing a run |
| Stabilizer | `seal` (its group report) |
| Calibrator | `seal` (a calibrator-only verdict) |
| Arbiter | `seal` (a full cell's verdict) |
| Architect · Auditor · Researcher | `seal` (their own artifacts) |
| PM | `mission claim` · `wave open` · `seal` (Charter, specs, Integration Notes, design decisions) · `supersede` (on the principal's word) · `worklist` · `acts` · `relay list` / `export` · `calib triggers` / `check` / `bundle` · `metrics` · `lint` · `gate close` · `contract add` · `adopt` (at migration) |

Recovery is never manual: on divergence or DB loss, `mp doctor` then `mp rebuild` — the journal makes DB loss a non-event. If doctor still reports divergence, stop and escalate; never repair state by hand.
