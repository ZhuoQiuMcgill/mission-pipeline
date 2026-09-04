---
description: Initialize mission-pipeline in the current project — create the state folders, bootstrap the deterministic substrate, briefly scout the existing codebase and conventions, and set up PROJECT.md through one pre-filled proposal. Use when the user asks to init, set up, or install the mission pipeline in a project, including old projects with an established workflow.
---

# Initialize mission-pipeline

Set up the mission-pipeline workflow in the current project, end to end. The canonical procedure is the skill's setup reference — **read it first and follow it**:

`${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/references/setup.md`

Execute its install steps in order, with these command-specific rules layered on top:

## 0 · Idempotency check (before anything else)

If `.claude/mission-pipeline/PROJECT.md` already exists, this project is initialized: report the current bindings and the ledger state (open missions in `ledger/MISSIONS.md`) in a few plain lines, ask whether the principal wants to re-run the interview, and stop unless they say yes. Never overwrite an existing PROJECT.md or ledger without explicit confirmation.

## 1 · Requirement folders (setup step 2)

Create `.claude/mission-pipeline/` and `.claude/mission-pipeline/ledger/`, and seed `ledger/MISSIONS.md` from `${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/templates/missions-registry.md` and `ledger/CONTRACTS.md` from `${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/templates/standing-contracts.md`. Anchor everything to the **main project root** — never to a worktree.

## 2 · Substrate bootstrap (setup step 3)

**You run these commands; the principal is never told to run anything** — the substrate is agent-internal (engine invariant 12).

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/scripts/mp" doctor
python3 "${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/scripts/mp" init
```

`doctor` is the environment check — Python ≥ 3.8 with stdlib `sqlite3`, mount type, journal/DB health. A failure here fails the install loudly, which is the point: a broken environment surfaces at setup, never mid-mission (Python ≥ 3.8 is required for new missions). `init` creates the state: `ledger/events.jsonl` (append-only journal) and `ledger/mp.db` (derived, rebuildable).

Two cases that are not a fresh install: a project already carrying a **v1.0.0** ledger runs `mp migrate` instead of `init` — it moves the existing schema forward, and no state is rewritten by hand; a **v0.3-era prose** ledger stays readable and is imported once via `mp adopt`.

## 3 · Scout the existing content (setup step 4)

Run the read-only scout exactly as setup.md describes — identity & ground rules, stack & layout, existing workflow & commit style, verification commands. Two rules for old projects:

- **Coexist, don't convert.** This pipeline changes nothing about an existing workflow: its state is confined to `.claude/mission-pipeline/`. Existing conventions (contribution guide, CI, doc systems) are *referenced* as ground rules in PROJECT.md, never edited.
- **Brief means brief.** Minutes, not an audit. The scout pre-fills the interview and orients the principal; the Architect does deep recon later, per mission.

Summarize findings to the principal in a few plain lines before moving on.

## 4 · One consolidated proposal, a single veto pass (setup step 5)

Present the whole interview as **one consolidated proposal**: every slot, pre-filled from the scout, in a single message — and take one veto pass over it. Ask individual questions only for what the scout cannot answer — typically just the principal's identity and the week scheme. Apply the week-scheme rule strictly (setup §9): adopt an existing counter → else `Week01` for a brand-new project → else **ask** — never invent, never the calendar week. Apply the document-map rule the same way (setup §12): an established design-doc tree is adopted, never restructured. The closing gate (setup §4), the Researcher/closure-audit executors (setup §11/§13 — default: PM-spawned fresh contexts; principal-run is an optional binding), and the calibration bindings (setup §14 — arbiter model) round out the proposal.

## 5 · Write PROJECT.md and confirm (setup steps 6–7)

Fill `.claude/mission-pipeline/PROJECT.md` from the template, play the bindings back in plain terms, adjust until signed off. Close by reporting what now exists (folders, substrate, registry, bindings) and that the next request can start the first mission.
