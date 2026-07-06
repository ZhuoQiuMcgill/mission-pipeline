# Project Bindings — mission-pipeline

<!--
BINDING CONTRACT — read before editing.
This is the ONLY file a project edits. It fills the declared slots below and may ADD
project rules. It may NOT restate, weaken, or override the engine — the lifecycle,
the group loop, or the invariants in the skill's SKILL.md. On any conflict, the
engine wins. Engine files (the skill folder) are never edited in a host project.
-->

## Principal
- **Name:** <who owns the vision and signs off missions>
- **Communication:** <anything notable — language, level of detail, cadence>

## Ground rules (mandatory reading for every agent)
<!-- The existing project docs that bind all work. Every handoff lists these. -->
- `<path/to/project instructions, e.g. CLAUDE.md>`
- `<path/to/contribution guide>`
- `<path/to/architecture doc>`

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
- **Run by:** principal, in a separate session, from the PM's written request <!-- default -->
- **External-evidence rules:** <path, if the project has its own research protocol>

## Additional project rules
<!-- Project-specific additions. May add; may not override the engine. -->
- <none yet>
