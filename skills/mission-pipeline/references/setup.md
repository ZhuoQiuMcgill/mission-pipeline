# Setup — first run in a project

Run this once per project, before the first mission. If `.claude/mission-pipeline/PROJECT.md` already exists, setup is done — skip to running missions.

## Install steps

1. **Skill present?** Confirm this skill is installed (as a plugin, or copied verbatim to `<project>/.claude/skills/mission-pipeline/` — engine files are never rewritten during install).
2. **Create the state directory:**
   - `<project>/.claude/mission-pipeline/`
   - `<project>/.claude/mission-pipeline/ledger/`
   - Copy `templates/missions-registry.md` → `ledger/MISSIONS.md`.
   - Copy `templates/standing-contracts.md` → `ledger/CONTRACTS.md`.
3. **Bootstrap the substrate — the agent runs this; the principal is never asked to (invariant 12).**
   From the main project root, using the skill's absolute path:
   - `python3 <skill>/scripts/mp doctor` — the environment check: Python ≥ 3.8 with stdlib
     `sqlite3`, mount type (DrvFS gets safe journal settings), journal/DB health. A failure
     here fails the install loudly — that is the point: a broken environment surfaces at
     setup, never mid-mission. **Python ≥ 3.8 is required for new missions.**
   - `python3 <skill>/scripts/mp init` — creates the substrate under the ledger:
     `ledger/events.jsonl` (append-only journal, authoritative for every state transition,
     refusals included) and `ledger/mp.db` (derived SQLite view, rebuildable by replay).
     It also carries the deployment's two declarations — `--closure sign-off|auto` and
     `--audit on|off` — but those are the principal's to make (§13, §15), so take the
     defaults here (`sign-off`, audit off) and record their answers after the interview,
     at step 7. `references/substrate.md` has the three-layer authority and the command
     surface.
   - `python3 <skill>/scripts/mp migrate` — only when the project already ran an earlier
     engine release: it upgrades an existing ledger's schema in place. Add `--repair` for a
     ledger that came through 1.0.0 or `mp adopt` — it re-stamps Charters amended in place
     while that was lawful, marks adopted prose-era artifacts as prose-only (exempt from the
     disk check), and backfills one wave `W1` for a mission holding specs but no wave: the
     three leftovers that would otherwise be reported as findings forever. A fresh install
     needs neither.
   - A v0.3-era prose ledger stays readable and is imported via `mp adopt` — never
     converted by hand.
4. **Scout the project — briefly, read-only.** Before asking the principal anything, explore what already exists; an old project answers most of the interview itself. Keep it to minutes, not an audit:
   - **Identity & ground rules** — README, project agent instructions (e.g. `CLAUDE.md`), `CONTRIBUTING`, the top level of any `docs/` tree.
   - **Stack & layout** — package manifests (`package.json`, `pyproject.toml`, …), top-level directories, obvious architectural boundaries.
   - **Existing workflow** — CI config, commit-message style from recent `git log`, any planning/reporting conventions already in use — including week-numbered files (feeds the week-scheme rule in §9).
   - **Verification** — test/build/lint commands from manifests, CI, or a Makefile.
   Summarize the findings to the principal in a few plain lines — this doubles as orientation in an unfamiliar project.
5. **Run the setup interview** (below) with the principal — **one consolidated proposal, a single veto pass**: present every slot, pre-filled from the scout, in one message for line-by-line veto. Ask individual questions only for what the scout cannot answer — typically just the principal's identity (§1) and the week scheme (§9).
6. **Offer the permission note — one yes/no.** `mp` is agent-internal (invariant 12), yet the harness prompts for each call, and a permission classifier reads command *names*: in the field the classifier refused the lifecycle verbs the engine used to expose — three attempts, no reason beyond "blocked by classifier" — while every other `mp` call had run for days unprompted, and a fully prepared mission sat for hours. The lifecycle is derived from documents now, so that particular trap is gone — but the deployment can still allow the tool once. Ask in one sentence — *"may I let myself run the pipeline's own state tool without a prompt each time?"* — and **on a yes you make the edit**; the principal never opens a file. Add to the project's `.claude/settings.json` allow list:
   ```
   Bash(python3 "${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/scripts/mp" *)
   ```
   A skill copied into `<project>/.claude/skills/` rather than installed as a plugin names its own absolute path instead of `${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline`. On a no, change nothing: the pipeline works exactly the same, with a prompt per call.
7. **Write PROJECT.md:** copy `templates/PROJECT.md` → `.claude/mission-pipeline/PROJECT.md` and fill every slot from the interview. Leave the contract header intact. Then record the principal's two declarations in the substrate, each carrying their own words: `mp config set closure sign-off|auto --quote "…"` and `mp config set audit on|off --quote "…"` — both appear in `mp acts`, repudiable like any other act taken in their name.
8. **Confirm.** Play the bindings back to the principal in plain terms; adjust until signed off. Then the pipeline is live — the next request starts the first mission.

## The setup interview

The interview is **one consolidated proposal and a single veto pass**: every slot below, pre-filled from the scout, presented in one message; the principal vetoes line by line. Ask individually only what the scout cannot answer — typically §1 (the principal) and §9 (the week scheme). The principal edits a proposal; they never sit an interrogation.

1. **Principal** — name; anything notable about how they want to be communicated with.
2. **Ground rules** — which existing docs bind every agent (contribution guide, project instructions, architecture docs)? These become mandatory reading in PROJECT.md.
3. **Tech constraints** — the architecture rules a Constructor must never violate and a Crititor must check (import discipline, state ownership, public contracts, size limits).
4. **Verification** — the commands that prove the project healthy (test suite, linters, build), with expected outcomes — and the **closing gate**: the full-scope command(s) run once per mission over the integrated result before the close. Task-level verification may be narrowed for speed; the closing gate may not (engine invariant 10).
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
11. **Researcher** — enabled? Run by — default: **a PM-spawned fresh context with engine-fixed inputs**; "principal, separate session" remains an optional binding. Where do external-evidence rules live, if the project has its own?
12. **Document map** — **scout first.** Where do design decisions (the "why" behind missions) live? An established project usually already has a tree (e.g. `docs/design_docs/`) — adopt it, never restructure it. A fresh project defaults to the mission folder's `design/`. The PM may not fan out a mission while this slot is unset. Also confirm the standing-contracts registry location (default `ledger/CONTRACTS.md`).
13. **Closure audit** — enabled (recommended)? Recorded with `mp config set audit on|off`; the default is off, and while it is on **no mission closes without a sealed Closure Audit** cited by its MissionClose note. Run by — default: **a PM-spawned fresh context with engine-fixed inputs**; "principal, separate session" remains an optional binding. Which model — a different family than the working seats when one is available; otherwise the same model in a fresh session. Heterogeneity is preferred, never required.
14. **Calibration** — which model takes the **arbiter** seat in the wave-boundary calibration cell: a different family than the working seats when one is available; heterogeneity is preferred, **never required** (the closure-audit rule). The Calibrator runs alone first, so the Arbiter and Challenger are convened only when it files an anchored accusation — most cells never spend those seats. Calibration seats default to PM-spawned fresh contexts with engine-fixed inputs; principal-run is an optional override, recorded in PROJECT.md's Calibration slots.
15. **Closure mode** — how missions close. The principal declares it and the PM never chooses it (engine invariant 9). **Propose `sign-off`** — they accept each mission in person — unless the scout found a standing delegation: a ratified contract, or the principal's own written rule, saying missions close without per-mission sign-off. Then propose **`auto`** and **name the contract**: auto mode requires a live standing-contract entry that delegates closure, and every MissionClose note cites it by id. If the principal wants auto and no such entry exists, draft one and ratify it on their word (`mp contract add`) before recording the mode. Either way the answer goes into PROJECT.md's **Closure mode** slot and into `mp config set closure`. Say plainly what auto does and does not change: the principal is never interrupted for procedure and repudiates item by item from `mp acts` afterwards — while a DRIFT halt, the SUSPICION ratchet and Charter amendments still stop the pipeline and still reach them.

## Upgrading the engine

To pick up an improved engine: replace this skill folder wholesale with the newer copy, then run `python3 <skill>/scripts/mp migrate` (schema forward for an existing ledger; `--repair` in addition clears what an older release left behind — in-place-amended Charters, adopted prose-era paths, a mission with specs but no wave) and `mp doctor`. Scripts (`scripts/mp`) are engine files exactly like the prose — replaced wholesale on upgrade, never edited in a host project. PROJECT.md and the ledger are untouched by design. To check for drift first: `diff -r` the project's skill folder against the source copy — any difference in a host project is drift, since engine files are never edited locally.
