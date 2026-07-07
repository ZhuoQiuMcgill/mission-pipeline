---
description: Initialize mission-pipeline in the current project — create the state folders, briefly scout the existing codebase and conventions, and set up PROJECT.md through a pre-filled interview. Use when the user asks to init, set up, or install the mission pipeline in a project, including old projects with an established workflow.
---

# Initialize mission-pipeline

Set up the mission-pipeline workflow in the current project, end to end. The canonical procedure is the skill's setup reference — **read it first and follow it**:

`${CLAUDE_SKILL_DIR}/../skills/mission-pipeline/references/setup.md`

Execute its install steps in order, with these command-specific rules layered on top:

## 0 · Idempotency check (before anything else)

If `.claude/mission-pipeline/PROJECT.md` already exists, this project is initialized: report the current bindings and the ledger state (open missions in `ledger/MISSIONS.md`) in a few plain lines, ask whether the principal wants to re-run the interview, and stop unless they say yes. Never overwrite an existing PROJECT.md or ledger without explicit confirmation.

## 1 · Requirement folders (setup step 2)

Create `.claude/mission-pipeline/` and `.claude/mission-pipeline/ledger/`, and seed `ledger/MISSIONS.md` from `${CLAUDE_SKILL_DIR}/../skills/mission-pipeline/templates/missions-registry.md`. Anchor everything to the **main project root** — never to a worktree.

## 2 · Scout the existing content (setup step 3)

Run the read-only scout exactly as setup.md describes — identity & ground rules, stack & layout, existing workflow & commit style, verification commands. Two rules for old projects:

- **Coexist, don't convert.** This pipeline changes nothing about an existing workflow: its state is confined to `.claude/mission-pipeline/`. Existing conventions (contribution guide, CI, doc systems) are *referenced* as ground rules in PROJECT.md, never edited.
- **Brief means brief.** Minutes, not an audit. The scout pre-fills the interview and orients the principal; the Architect does deep recon later, per mission.

Summarize findings to the principal in a few plain lines before moving on.

## 3 · Interview, pre-filled (setup step 4)

For every slot the scout answered, propose the scouted answer for veto; ask open questions only for the gaps. Apply the week-scheme rule strictly (setup §9): adopt an existing counter → else `Week01` for a brand-new project → else **ask** — never invent, never the calendar week.

## 4 · Write PROJECT.md and confirm (setup steps 5–6)

Fill `.claude/mission-pipeline/PROJECT.md` from the template, play the bindings back in plain terms, adjust until signed off. Close by reporting what now exists (folders, registry, bindings) and that the next request can start the first mission.
