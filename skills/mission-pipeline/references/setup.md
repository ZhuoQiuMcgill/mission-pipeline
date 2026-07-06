# Setup — first run in a project

Run this once per project, before the first mission. If `.claude/mission-pipeline/PROJECT.md` already exists, setup is done — skip to running missions.

## Install steps

1. **Skill present?** Confirm this skill folder is at `<project>/.claude/skills/mission-pipeline/` (copied verbatim from its source project — engine files are never rewritten during install).
2. **Create the state directory:**
   - `<project>/.claude/mission-pipeline/`
   - `<project>/.claude/mission-pipeline/ledger/`
   - Copy `templates/missions-registry.md` → `ledger/MISSIONS.md`.
3. **Run the setup interview** (below) with the principal — plain language, a few questions at a time.
4. **Write PROJECT.md:** copy `templates/PROJECT.md` → `.claude/mission-pipeline/PROJECT.md` and fill every slot from the interview. Leave the contract header intact.
5. **Confirm.** Play the bindings back to the principal in plain terms; adjust until signed off. Then the pipeline is live — the next request starts the first mission.

## The setup interview

Ask only what the project cannot answer itself; propose defaults and let the principal veto rather than interrogating.

1. **Principal** — name; anything notable about how they want to be communicated with.
2. **Ground rules** — which existing docs bind every agent (contribution guide, project instructions, architecture docs)? These become mandatory reading in PROJECT.md.
3. **Tech constraints** — the architecture rules a Constructor must never violate and a Crititor must check (import discipline, state ownership, public contracts, size limits).
4. **Verification** — the commands that prove the project healthy (test suite, linters, build), with expected outcomes.
5. **Commit policy** — author identity, message convention, branching rule, any attribution restrictions.
6. **Model picks** — which model runs each role (see PROJECT.md template for the recommended shape).
7. **Round cap** — default 3; raise or lower only with a reason.
8. **Naming prefix** — optional filename prefix for ledger artifacts; default none.
9. **Week scheme** — **scout first; never invent a week number.** Before asking, look for timeline evidence in the project: status or planning docs that count weeks, week-numbered filenames, a changelog, the repo's age. Then:
   - **The project already counts weeks** → adopt its counter, record the current week and what date the count starts from.
   - **Brand-new project, no history** → start at `Week01`.
   - **Evidence unclear or mixed** → ask the principal whether mission names should carry a week number at all — and if yes, which week it currently is. Do not guess, and do not fall back to the calendar week: a calendar-week stamp (e.g. `Week27` on a fresh project) is exactly the "random number" this rule exists to prevent.
   - If the principal opts out, mission names drop the prefix entirely and are just `<MissionName>` — the registry still enforces uniqueness.
   Record the outcome in PROJECT.md, including the start date of the count when weeks are on.
10. **Ledger location** — default `.claude/mission-pipeline/ledger/` (untracked, branch-independent); relocate into the repo (e.g. `docs/…`) only if the principal wants the paper trail in version control.
11. **Researcher** — enabled? Who runs it (default: principal, separate session)? Where do external-evidence rules live, if the project has its own?

## Upgrading the engine

To pick up an improved engine: replace this skill folder wholesale with the newer copy. PROJECT.md and the ledger are untouched by design. To check for drift first: `diff -r` the project's skill folder against the source copy — any difference in a host project is drift, since engine files are never edited locally.
