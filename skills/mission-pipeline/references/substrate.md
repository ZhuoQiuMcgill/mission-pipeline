# The Substrate — deterministic state under the paper

`mp` is the pipeline's state tool: one stdlib-only Python script (this skill's `scripts/mp`) that owns every state transition — missions, artifacts, rounds, verdicts, flags, evidence, the Charter, the gate. Judgment stays in prose; determinism lives here; derived state is disposable.

**Agent-internal only — invariant 12: the principal converses; agents operate.** `mp` never appears in anything the principal is asked to do; no pipeline step may require the principal to run it. Invoke it as:

```bash
python3 <absolute path to skill>/scripts/mp <command> …
```

Attribute every call: `--actor <role[:task]>` (e.g. `--actor stabilizer:T7`) or the `MP_ACTOR` environment variable. Python ≥ 3.8, stdlib only; `mp doctor` fails init loudly if the environment cannot support it — never mid-mission.

## Three layers, one write path

| Layer | File | Authority |
|---|---|---|
| Event journal | `ledger/events.jsonl` | **authoritative for every state transition — including refusals.** Append-only text; history physically unrewritable. |
| SQLite | `ledger/mp.db` | derived, operational — rebuildable by replay (`mp rebuild`); disposable. |
| Markdown | the ledger's artifacts | **authoritative for judgment** — the prose behind every verdict. |

Every state change goes through one `mp` command, which appends the journal line first (fsync), then applies it to the DB, under a lock. **Never write the DB directly** — no `sqlite3`, no hand edits; `mp doctor` replays the journal against the DB and reports divergence, so a bypass is detected, not debated.

## REFUSED is the engine speaking

`mp` refuses illegal transitions — a round past the cap, a duplicate version, a gate close over undisposed flags — and **journals the refusal too**: the enforcement layer of a system built on "silence is not disposal" does not itself work silently.

**Never route around a refusal.** Do not retry with altered arguments to make it pass; do not hand-edit files to the same effect. A refusal means an engine invariant is in the way — escalate up the ladder (Constructor/Crititor → Stabilizer → PM → principal) with the refusal line quoted verbatim.

## Command surface

| Command | When |
|---|---|
| `mp init` | once, at setup — creates the substrate (dirs, DB, journal) |
| `mp doctor` | health: environment, journal/DB divergence, seal integrity — at setup, and whenever anything looks off |
| `mp rebuild` | rebuild `mp.db` by replaying the journal — after DB loss or doctor divergence |
| `mp migrate` | check/upgrade the schema version after an engine upgrade |
| `mp status` | orientation: missions, undisposed flags, journal seq |
| `mp mission claim` / `close` | atomic registry claim at kickoff; close on the principal's sign-off |
| `mp artifact new` / `seal` | mint an artifact ID + header at creation; freeze + hash when finished |
| `mp edge add` | record derives-from / cites / carries links between artifacts |
| `mp round open` / `close` | bound the group loop — refuses past the cap |
| `mp verdict record` | verdicts as facts: PASS / CHANGES-REQUESTED · ALIGNED / SUSPICION / DRIFT · … |
| `mp flag add` / `dispose` | the flag ledger; the gate refuses to close while any flag is undisposed |
| `mp evidence add` | typed evidence rows (`--type R\|F\|D\|X`); R requires fingerprint + output hash |
| `mp fingerprint take` | source-state identity (commit SHA + dirty state + tree hash) — before verification runs |
| `mp charter seal` / `amend` | freeze the Charter before decomposition; amend only on the principal's verbatim words |
| `mp gate record` | record a verification-gate run, bound to its log hash and fingerprint |
| `mp gate close` | the hardened close — five checks, all must pass: Charter sealed · every flag disposed · a closing-gate run with its log bound · a fresh fingerprint still matching that run (fail closed on source drift) · zero lint findings (stale Charter anchors surface here) |
| `mp contract add` | standing-contract entries (Charter prohibitions land here at sealing) |
| `mp calib bundle --seat calibrator\|challenger` | rule-derived calibration inputs — the PM cannot curate |
| `mp calib check` | the calibration verdict state: exits non-zero while the latest aggregate verdict is DRIFT (fan-out halted) or two consecutive waves read SUSPICION (ratchet — auto-escalate); lists task-cell DRIFTs not yet cleared. Task-cell *triggers* are the PM's check at each Crititor `PASS`, not this command's |
| `mp metrics` | mechanical cross-wave metrics — the only legal source for a trend claim |
| `mp lint` | evidence-law mechanics on live artifacts: header consistency · D-only evidence chains under a PASS · summaries cited as roots · stale Charter anchors and superseded citations · R rows missing their fingerprint (missing out-of-scope stays the Architect's Pass 2 lint) |
| `mp adopt` | import a v0.3-era prose ledger, once, at migration |

## The artifact header

Every artifact opens with a machine-readable block (templates carry it pre-filled):

```
<!-- mp:header
mission: <name>
category: <Category>
key: <key>
round: <int>
version: <int>
derives-from: <comma-separated artifact ids, or none>
-->
```

IDs come from `mp artifact new` — never invented. `mp lint` checks presence and staleness.

## Evidence law

Every evidence citation in a verdict-bearing artifact carries a type and an anchor:

| Type | Root | Anchor form |
|---|---|---|
| **R** | reality — executed command, re-run test, observed behavior | the exact command / test id — binds to a fingerprint + output hash |
| **F** | fixed point — frozen before the mission web | `charter:v<N>[:<ref>]` · `contract:<id>` · `project:<section>` · `amendment:v<N>` |
| **D** | derived — any mission-era document | `artifact:<id>[:<section>]` |
| **X** | external — a source the Researcher actually fetched and verified | the verified URL; unverified sources are leads, never anchors |

The six rules:

1. **D+D agreement = zero weight.** Corroboration counts distinct roots, not documents.
2. **Every criterion marked "met" needs ≥1 R or F anchor.** A verdict resting only on D is structurally circular — flagged by `mp lint`, no judgment required.
3. **D never upgrades.** A D-only claim gains no confidence by being cited more.
4. **R binds to source state.** Verification fails closed on fingerprint mismatch.
5. **Summaries are never citable roots.** Cite the underlying artifact a summary carries — the generalization of "flags travel verbatim."
6. **Stale citations are flagged.** Citing v01 where v03 exists is a lint finding; Charter amendments propagate staleness automatically.

This is invariant 13 operationalized: *echoes are not evidence.*

## Who runs what

| Actor | Commands |
|---|---|
| Constructor | `fingerprint take` · `evidence add` — per requirement, before reporting |
| Crititor | `verdict record` (PASS / CHANGES-REQUESTED) |
| Stabilizer | `round open`/`close` · `verdict record` (group outcome; cell verdicts as Arbiter) · `flag add` (carrying flags verbatim) |
| PM | `mission claim`/`close` · `charter seal`/`amend` · `flag dispose` · `gate record`/`gate close` · `metrics` · `calib bundle` · `calib check` · `lint` · `contract add` · `adopt` (at migration) |
| Every author | `artifact new` at creation · `artifact seal` on finish — its own artifacts only · `edge add` for their derives-from links |

Recovery is never manual: on divergence or DB loss, `mp doctor` then `mp rebuild` — the journal makes DB loss a non-event. If doctor still reports divergence, stop and escalate; never repair state by hand.
