# The Substrate — deterministic state under the paper

`mp` is the pipeline's state tool: one stdlib-only Python script (this skill's `scripts/mp`) that owns every state transition. Judgment stays in prose; determinism lives here; derived state is disposable.

**Agent-internal only — invariant 12: the principal converses; agents operate.** `mp` never appears in anything the principal is asked to do; no pipeline step may require the principal to run it. Invoke it as:

```bash
python3 <absolute path to skill>/scripts/mp <command> …
```

Attribute every call: `--actor <role[:task]>` (e.g. `--actor stabilizer:T7`) or the `MP_ACTOR` environment variable. Python ≥ 3.8, stdlib only; `mp doctor` fails init loudly if the environment cannot support it — never mid-mission.

## Derive, don't declare — the one rule

**Agents write documents. The engine derives the records.** Write your artifact once, then submit it with a single call — `python3 <skill>/scripts/mp seal <absolute path>` — and `mp` derives everything the ledger holds: the artifact and its id (the `mp:header` block), evidence rows (the criteria table), flags (Out-of-frame and Noticed-but-not-fixed), verdicts (the verdict line), the round, the edges (`derives-from`), dispositions (an Integration Note's flag ledger), relay items (`## Engine relay`). Nothing is typed twice, so nothing in the ledger can disagree with the document it came from.

Only three commands still take a fact no document contains, because it happened outside the text: `mp run record` (an execution happened, over this tree), `mp supersede` (this record no longer stands), and `mp config set` (the principal declared how this deployment works). Everything else is a read.

## The document contract

Every artifact opens with this block, inside its first 40 lines:

```
<!-- mp:header
mission: <mission name>
category: <TaskSpec|DevReport|Critique|GroupReport|ArchPlan|DesignDoc|IntegrationNote|ClosureAudit|MissionClose|Charter|CalibrationVerdict|ResearchRequest|ResearchResult|ResearchTrail>
key: <T<n> task-scoped | mission name (Charter, ArchPlan, IntegrationNote, ClosureAudit, MissionClose) | W<n> aggregate CalibrationVerdict | topic>
round: <int; 0 when not round-scoped>
version: <int>
wave: <W<n>>                      # REQUIRED on TaskSpec and IntegrationNote
branch: <mission branch>          # Charter only, optional — fills the registry line at the claim
cap: <int>                        # Charter only, optional — this mission's round cap
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
| **MissionClose** | `## Closing run` — one `run:<id>`, recorded `--scope closing` · `## Closure audit` — `artifact:<id>` of the sealed ClosureAudit (required while the audit is on) · `## Principal's acceptance` — their verbatim words (required in sign-off mode) · `## Delegation` — `contract:<id>` of the live delegating contract (required in auto mode) · `## Outcome` |
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
| a `met` row whose **R** anchor is a run recorded `--expect fail` | a deliberate red batch anchors the fail-before half only — cite the pass-after run |
| a TaskSpec whose wave is not open, or whose out-of-scope is empty | waves carry the calibration teeth; invariant 5 |
| a Charter v*N* without its amendment row | an amendment is the principal's words or it is not an amendment |
| an Integration Note disposing an unknown flag, or leaving a disposition empty | invariant 11 — silence is not disposal |
| an unresolvable `derives-from`, an anchor to an unknown `run:` / `contract:` / `artifact:` id, or a missing header field | the document must say where it came from — a made-up id was how the field's journal got poisoned |
| a required section missing (Critique: Verdict, Criteria table, Out-of-frame risk · DevReport: Runs, Noticed but not fixed · Integration Note: Flag ledger, Compaction · GroupReport: Outcome · CalibrationVerdict: Verdict, Convened · TaskSpec: Out of scope · MissionClose: Closing run, Outcome) | the parser derives from these; a "None" bullet satisfies a flag section |
| a MissionClose while a flag is undisposed, the mission's lint has findings, the Charter is unsealed, the closing run is missing, drifted, or bound by `--commit` rather than measured, a required Closure Audit is absent, or the mode's own section is missing — every failing condition named at once | the close is a document like any other — and the last place these can still be caught (invariants 10, 11) |

**REFUSED is the engine speaking**, and the refusal is journaled like any other event. Fix the **document** and seal again. **Never route around a refusal:** no retry with altered arguments to make it pass, no hand-edit to the same effect, no re-plan around a halt. A refusal you believe is wrong is an engine defect — put it under `## Engine relay` and escalate up the ladder (Constructor/Crititor → Stabilizer → PM → principal) with the refusal line quoted verbatim.

## Configuration — the principal's two declarations

| Setting | Values | Default | Decides |
|---|---|---|---|
| `closure` | `sign-off` \| `auto` | `sign-off` | who closes a mission: the principal in person, or the PM under a standing contract that delegates closure |
| `audit` | `on` \| `off` | `off` | whether a sealed ClosureAudit is required before a mission can close |

```bash
mp config set closure auto --quote "<the principal's verbatim words>"
mp config set audit   on   --quote "<the principal's verbatim words>"
```

`mp init --closure sign-off|auto [--audit on|off]` sets them at setup; `mp config get [key]` reads them back (with `source: default` for anything never declared). Both are declared by the principal in PROJECT.md and recorded by the PM **on their word**: every `config.set` is an act in the principal's name, carries their quote, appears in `mp acts`, and is repudiable there like any other. The PM never chooses the closure mode (invariant 9), and an act you cannot quote the principal for is an act you may not execute.

## The derived lifecycle — the Charter claims, the note closes

The mission lifecycle is derived from documents, exactly like the evidence:

| Transition | What performs it |
|---|---|
| **claim** | sealing the mission's **Charter v1** — it derives the `MISSIONS.md` line, taking the branch from the header's optional `branch:` and this mission's round cap from `cap:` |
| **close** | sealing the mission's **MissionClose** note — `key` = the mission name, template `templates/mission-close.md` |
| **reopen** | `mp supersede mission:<name> --by principal --reason "<their verbatim words>"` — a repudiation, and the only thing that reopens a closed mission |

The MissionClose seal **refuses, naming the condition**, while: any flag on the mission is undisposed · the mission's own lint has findings — **the seal lints this mission only**, so paperwork elsewhere in the deployment never blocks a close · the closing run is missing or the tree it judged no longer matches · the closure audit is on and no sealed ClosureAudit is cited · the section the closure mode requires is missing (`## Principal's acceptance` under sign-off, a live `contract:<id>` in `## Delegation` under auto). In auto mode the close itself lands in `mp acts`.

There is no `claim` verb and no `close` verb, deliberately: a harness permission classifier reads command names, and in the field the lifecycle verbs were refused as governance acts — three attempts, no reason beyond "blocked by classifier" — while every other `mp` call had been running for days without a prompt.

## Runs — verification is a shared fact

```bash
mp run record --cmd "<command>" --log <file> --result pass|fail|mixed \
              [--tree <worktree path>] [--scope closing] [--expect fail] [--commit <sha>]
```

Returns `run:<id>`. **Whoever executes a verification records it once; every other seat cites the id.** Five seats re-running one suite because none can trust another's run is the cost this replaces.

- **`--result` on every call.** The row, not the log, is what a later seat reads.
- **`--tree`** in a worktree: the run binds to the tree it judged and fingerprints it, so no separate `mp fingerprint take` is needed. **Git's own tree id is recorded beside that fingerprint** — a project rule may compare a row against `git rev-parse HEAD^{tree}`, which the content fingerprint can never equal.
- **`--commit <sha>`** when the tree has already moved since the execution. That binding is *declared*, not measured; record immediately whenever you can.
- **`--expect fail`** marks a deliberate fail-before batch, so a red suite and a green one stop being the same kind of row. An expect-fail run is **never a passing anchor** — a `met` row cites the pass-after run.
- **A script path is a legal command**, and its hash is recorded too, so a verification that stands services up, migrates them and tears them down can be re-run exactly as it ran.
- **Identity is (tree, command, output, scope).** An identical second record returns the existing id — but a closing-scope record of an output an earlier task-scope run already produced is a different run, and is accepted.
- **`mp run list` / `mp run show <id>`** read the table.

Re-run only to **dispute** a run; then record your own and say what it disputes.

## Supersession — every record can be retired

`mp supersede <kind>:<id> --by <kind>:<id>|principal|reality --reason "…"`.

- Sealing a new version of a document supersedes every record the previous version derived — evidence rows, verdicts, edges, relay items. **Flags are the exception**: they carry dispositions, so they reconcile instead (below).
- `--by principal` is the only way a calibration verdict is cleared; the reason carries the principal's verbatim words and the act appears in `mp acts`. `--by reality` retires what a later run disproved.
- **Rules read live records only.** A superseded record stays in the journal as history and stops binding anything.
- Whatever depended on a superseded record appears in **`mp worklist`** — a to-do for the PM to judge (*does this change matter to that judgement?*), **never an error**, and never an automatic re-issue.
- `mp supersede mission:<name> --by principal` is a repudiation: it reopens a closed mission.

### Re-issue reconciles flags by text

A re-issued document's `## Noticed but not fixed` and `## Out-of-frame risk` are matched against the previous version's **live** flags:

| The bullet | What happens |
|---|---|
| its text matches a live flag from the previous version | it **carries** that flag — same id, disposition kept |
| an old flag no bullet matches | retired with its version |
| new text | a new flag |

Say a carry outright — `- carried: flag:<id>` or `- carried: <the flag's text>` — and **a carried bullet never creates a flag.** Re-deriving every bullet is right for a first seal and wrong for a re-issue: in the field one 17-item residue list re-derived across three versions produced **52 flags**, and its mission carried 77 undisposed items toward close. The same lesson's other half: never write *"the previous round's flags still stand"* — that sentence is a bullet, so it becomes a flag about flags.

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
| `mp init` | once, at setup — creates the substrate (dirs, DB, journal); `--closure sign-off\|auto` and `--audit on\|off` set the deployment's declarations |
| `mp config set closure\|audit <value> --quote "…"` | record the principal's declaration — the PM runs it on their word, and it appears in `mp acts` |
| `mp doctor` | health: environment, journal/DB divergence, seal integrity — at setup, and whenever anything looks off |
| `mp rebuild` | rebuild `mp.db` by replaying the journal — after DB loss or doctor divergence |
| `mp migrate` | upgrade the schema after an engine upgrade (v1 / v2 → v3). `--repair` cleans what earlier releases left behind: 1.0.0 Charters amended in place are re-stamped so `doctor` stops reporting them, adopted prose-era artifacts are marked prose-only (exempt from the disk check), and a mission holding specs but no wave gets one backfilled `W1`. A pre-1.1 TaskSpec with no `touches-contract` header counts as `yes` when triggers are computed — the conservative reading |
| `mp status` | orientation: missions, open waves, undisposed flags, journal seq |
| `mp wave open W<n> --mission <name> --tasks T4,T5,…` / `close` | open before **every** fan-out, single-wave missions included; the wave declares its task set. **Refuses while a DRIFT stands or two consecutive SUSPICIONs stand.** Sealing the wave's Integration Note closes it; `close` by hand is for a wave abandoned without one |
| `mp seal <path>` | the write path for documents — parses, derives every record, runs the rules. **A Charter v1 seal claims the mission; a MissionClose seal closes it** |
| `mp run record` | `--cmd` · `--log` · `--result` (always) · `--tree` (worktrees) · `--scope closing` · `--expect fail` · `--commit` → `run:<id>`; the shared verification fact |
| `mp run list` / `show <id>` | read the recorded runs |
| `mp supersede <kind>:<id>` | retire a record — kinds `artifact` · `verdict` · `flag` · `evidence` · `charter` · `contract` · `run` · `mission` (a repudiation, which reopens it); `--by <kind>:<id>` / `principal` / `reality`, with a `--reason` |
| `mp worklist` | what still depends on something superseded — the PM's to-do, not an error |
| `mp acts --mission <name>` | the acts executed in the principal's name — amendments, ratifications, cleared verdicts, `config.set`, and in auto mode the close itself; pasted into the Integration Note and presented as the repudiation list |
| `mp relay add --kind defect\|inefficiency\|suggestion --text …` / `list` / `export` | the engine relay: file, read, and export observations about the pipeline itself |
| `mp calib triggers` | which tasks earned a task-level cell — computed, not remembered |
| `mp calib check` | the standing verdict state: a DRIFT halt, a fired ratchet |
| `mp calib bundle --seat calibrator\|challenger` | rule-derived calibration inputs — the PM cannot curate |
| `mp metrics` | mechanical cross-wave metrics — the only legal source for a trend claim |
| `mp lint [--mission <name>]` | evidence-law mechanics over **live** records: header consistency · D-only chains · summaries cited as roots · stale Charter anchors and superseded citations · R rows whose run no longer matches its tree |
| `mp contract add` | a ratification that is not a Charter prohibition — those ratify themselves when the Charter seals |
| `mp adopt` | import a v0.3-era prose ledger, once, at migration |

**Deprecated compatibility aliases.** `mp artifact new` · `artifact seal` · `evidence add` · `edge add` · `flag add` · `flag dispose` · `round open` / `close` · `verdict record` · `charter seal` / `amend` · `gate record` are all superseded by `mp seal` and `mp run record`; **`mp gate close` · `mp mission claim` · `mp mission close` are retired** by the derived lifecycle above — the Charter v1 seal is the claim and the MissionClose seal is the close. All of them survive only so an older ledger keeps replaying. **Do not use them in any new work**; nothing in the roles or templates calls them, and this is the only place they are named.

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
| PM | `config set` (on the principal's word) · `wave open` · `seal` (the Charter — which claims the mission — specs, Integration Notes, design decisions, and the MissionClose note, which closes it) · `supersede` (on the principal's word, `mission:<name>` on a repudiation) · `worklist` · `acts` · `relay list` / `export` · `calib triggers` / `check` / `bundle` · `metrics` · `lint` · `run list` / `show` · `contract add` · `migrate` / `adopt` (at upgrade) |

Recovery is never manual: on divergence or DB loss, `mp doctor` then `mp rebuild` — the journal makes DB loss a non-event. If doctor still reports divergence, stop and escalate; never repair state by hand.
