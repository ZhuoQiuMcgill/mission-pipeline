# Project Bindings — mission-pipeline

<!--
BINDING CONTRACT — read before editing.
This is the ONLY file a project edits. It fills the declared slots below and may ADD
project rules. It may NOT restate, weaken, or override the engine — the lifecycle,
the group loop, or the invariants in the skill's SKILL.md. On any conflict, the
engine wins. Engine files (the skill folder) are never edited in a host project.
-->

## Principal
- **Name:** <who owns the vision and closes missions — see Closure mode>
- **Communication:** <anything notable — language, level of detail, cadence>

## Ground rules (mandatory reading for every agent)
<!-- The existing project docs that bind all work. Every handoff lists these. -->
- `<path/to/project instructions, e.g. CLAUDE.md>`
- `<path/to/contribution guide>`
- `<path/to/architecture doc>`

## Document map
<!-- Where the "why" lives. The PM may not fan out a mission while a slot here is unset —
     resolve it with the principal first. Mid-pipeline adoptions keep their existing tree:
     point the slot at it; never restructure the host project's docs. -->
- **Mission rationale (design decisions):** `<default: <ledger>/<Mission>/design/ — or the project's own tree, e.g. docs/design_docs/>`
- **Standing contracts:** `<ledger>/CONTRACTS.md` <!-- default; seeded at setup from templates/standing-contracts.md -->

## Tech constraints (Constructor must obey; Crititor must check)
<!-- The architecture rules that bite: import discipline, state ownership, contracts, size limits. -->
- <rule 1>
- <rule 2>

## Verification
<!-- Commands that prove the project healthy, with expected outcomes. -->
```bash
<test command>        # expect: <outcome>
<lint/build command>  # expect: <outcome>
```
- **Closing gate (full scope):** `<the command(s) run once over the integrated result before the close>` <!-- engine invariant 10: task-level verification may be narrowed per spec; this gate may not -->
- **Closing-gate log location:** `<default: the mission folder's gate/ — the recorded gate run binds this log and its hash to a source fingerprint>`

## Commit policy
- **Author:** <identity commits are authored as>
- **Convention:** <e.g. Conventional Commits>
- **Branching:** <e.g. branch off main; mission branch per mission>
- **Restrictions:** <e.g. no AI-attribution marks anywhere>

## Model picks
<!-- Which model runs each role. Recommended shape: fast capable builder; strongest available reviewer; strong judge for the stabilizer; PM on the principal's default. -->
- PM: <model>
- Architect: <model>
- Constructor: <model — fast builder>
- Crititor: <model — strongest reviewer>
- Stabilizer: <model — strong judge>

## Pipeline settings
- **Round cap (N):** 3 <!-- change only with a reason; boundedness itself is an invariant -->
- **Naming prefix:** <empty by default; e.g. "MyProject_">
- **Week scheme:** <from setup — e.g. "project weeks, currently Week04, counting from <date>" · "Week01 — new project, started <date>" · "none — mission names carry no week prefix"> <!-- settled by scouting the project's timeline at setup; NEVER invented, never the calendar week -->
- **Ledger location:** `.claude/mission-pipeline/ledger/` <!-- relocate (e.g. into docs/) only to put the trail under version control -->

## Researcher
- **Enabled:** <yes/no>
- **Run by:** PM-spawned fresh context with engine-fixed inputs, from the PM's written request <!-- default; principal-run in a separate session is an optional override — see Calibration -->
- **External-evidence rules:** <path, if the project has its own research protocol>

## Closure mode
<!-- The principal's declaration, and the only place it is declared. The PM reads it and
     never chooses it (engine invariant 9); it is recorded in the substrate with
     `mp config set closure sign-off|auto --quote "<the principal's own words>"`.
     sign-off (default) — the principal accepts each mission in person, and the MissionClose
       note carries their verbatim words.
     auto — the PM closes each mission itself under a ratified standing contract, the
       principal is never interrupted for procedure, and they repudiate item by item from
       `mp acts` (a repudiation reopens the mission). Auto REQUIRES the contract below.
     Both modes stop identically on the substantive things: a DRIFT halt, the SUSPICION
     ratchet, a Charter amendment. -->
- **Mode:** sign-off <!-- sign-off | auto -->
- **Delegating standing contract:** <auto only, required: `contract:<id>` of the live registry entry that delegates closure — the MissionClose note cites it> / n/a

## Closure audit
- **Enabled:** <yes/no — recommended yes> <!-- recorded with `mp config set audit on|off`; default off. While on, no mission closes without a sealed Closure Audit cited by its MissionClose note. -->
- **Run by:** PM-spawned fresh context with engine-fixed inputs <!-- default; the PM spawns it but never edits its report; principal-run in a separate session is an optional override — see Calibration -->
- **Model:** <a different family than the working seats when available; otherwise the same model in a fresh session — heterogeneity is preferred, never required>

## Calibration
- **Arbiter model:** <a different family than the working seats when available; otherwise the same model in a fresh session — heterogeneity is preferred, never required>
- **Principal-run overrides:** <none by default — Researcher, Auditor, and calibration seats run as PM-spawned fresh contexts with engine-fixed inputs; list any seat here to run it principal-side in a separate session instead>

## Additional project rules
<!-- Project-specific additions. May add; may not override the engine. -->
- <none yet>
