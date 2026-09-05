<!-- mp:header
mission: <Mission>
category: TaskSpec
key: T<n>
round: 0
version: <NN>
wave: W<n>
recovers: <T<n> — only if this task was opened to repair another task's escalation; delete otherwise>
touches-contract: <yes|no>
derives-from: <artifact:<DesignDoc id>, or none>
-->
<!-- wave: the wave this task fans out in. `mp wave open W<n>` must have run or the seal
     is refused — that is where a standing DRIFT or a fired ratchet stops the mission.
     touches-contract: yes when the task changes something other tasks or the product
     depend on — an interface, a data shape, a verification path; a prose-only or
     records-only task is no. It drives a calibration trigger, so get it right.
     Document contract: references/substrate.md. -->
# Task Spec — T<n>: <Short Name>

- **Mission:** `<Mission — named per PROJECT.md's scheme>`
- **Author:** PM · **Date:** <YYYY-MM-DD> · **Version:** v<NN>
- **Design decision:** `<ledger>/design/<DesignDoc file>` — why this task exists

## Mandatory reading (in order)
<!-- These are inputs for every seat in the group — the Crititor reads them too, not just
     the Constructor. A criterion that cannot be judged without one of them will wait on it. -->
1. `<absolute path>/.claude/mission-pipeline/PROJECT.md` — project bindings
2. `<absolute path to skill>/roles/constructor.md` — your role
3. <the mission's design decision — why this task exists>
4. <the seam contract, by section, if this wave has one>
5. <code files / further docs this task depends on — keep the list to 3–5 total>

## Context
<Why this task exists and the current state of the code it touches. 3–6 lines.>

## Requirements (numbered; each independently checkable)
1. <observable end state — not "improve" or "clean up">
2. …

## Out of scope — do NOT
<!-- Mandatory, and mechanically checked: a spec whose list is empty is REFUSED at seal
     (invariant 5). Real bullets — "nothing" is not a bullet. -->
- <files, modules, or behaviors to leave alone>

## Constraints
- <the PROJECT.md tech constraints that bite on this task, restated concretely>
- <API stability, performance bounds, size limits>
- Standing contracts touched: <entries from the registry this task could affect / none>

## Acceptance criteria (the review contract — each maps to ≥1 requirement)
<!-- Each must be anchorable by an R (a recorded run) or F (a frozen line) anchor. A
     criterion only mission-era documents could settle is unanchorable: the Architect's
     Pass 2 lint catches it, and the Crititor cannot mark it met (invariant 13). -->
- [ ] <criterion with an observable check>
- [ ] …

## Verification commands (exact, with expected outcomes)
<!-- The Constructor runs these and records each with `mp run record … --result pass|fail|mixed`
     — one run id per command, cited by every seat downstream instead of re-running. -->
```bash
<command>   # expect: <outcome>
```

## Report
Write the Implementation Report to `<anchored ledger path>/<Mission>/constructor/DevReport_T<n>_<YYYY-MM-DD>_v01.md` (template: skill `templates/dev-report.md`), then seal it: `python3 <skill>/scripts/mp seal <that path>`.

## Execution context
<!-- Filled by the PM at spawn time. -->
- **Worktree:** <absolute path, if isolated> · **Branch:** <task branch>
- **Ledger (anchored, absolute):** <main-root ledger path — never write to a worktree's .claude/>
