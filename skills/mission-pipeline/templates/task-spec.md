# Task Spec — T<n>: <Short Name>

- **Mission:** `<Mission — named per PROJECT.md's scheme>`
- **Author:** PM · **Date:** <YYYY-MM-DD> · **Version:** v<NN>
- **Design decision:** `<ledger>/design/<DesignDoc file>` — why this task exists

## Mandatory reading (in order)
1. `<absolute path>/.claude/mission-pipeline/PROJECT.md` — project bindings
2. `<absolute path to skill>/roles/constructor.md` — your role
3. <the design docs / code files this task depends on — keep to 3–5>

## Context
<Why this task exists and the current state of the code it touches. 3–6 lines.>

## Requirements (numbered; each independently checkable)
1. <observable end state — not "improve" or "clean up">
2. …

## Out of scope — do NOT
<!-- Mandatory. An empty list means the spec is not finished. -->
- <files, modules, or behaviors to leave alone>

## Constraints
- <the PROJECT.md tech constraints that bite on this task, restated concretely>
- <API stability, performance bounds, size limits>

## Acceptance criteria (the review contract — each maps to ≥1 requirement)
- [ ] <criterion with an observable check>
- [ ] …

## Verification commands (exact, with expected outcomes)
```bash
<command>   # expect: <outcome>
```

## Report
Write the Implementation Report to
`<anchored ledger path>/<Mission>/constructor/DevReport_T<n>_<YYYY-MM-DD>_v01.md`
(template: skill `templates/dev-report.md`).

## Execution context
<!-- Filled by the PM at spawn time. -->
- **Worktree:** <absolute path, if isolated> · **Branch:** <task branch>
- **Ledger (anchored, absolute):** <main-root ledger path — never write to a worktree's .claude/>
