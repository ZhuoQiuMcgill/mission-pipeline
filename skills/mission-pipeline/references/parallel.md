# Parallel execution — waves, collisions, worktrees

Read before fanning out groups. The point of groups is wall-clock: many bounded loops running at once, none of them routing through the PM. The danger is collision: two groups mutating the same files. This file is how to get the first without the second.

## When to scale

- **A few tasks:** skip all of this — the PM eyeballs dependencies, holds the Stabilizer seat, runs loops directly (sequentially or not at all in parallel).
- **Many tasks (≈5+), or any file-collision risk:** run the Architect's Pass 2 and execute in waves.

## Building waves from the DAG

The Architect delivers, per task: files touched, dependencies (needs another task's output), collisions (shares files). The PM turns that into waves:

1. Wave 1 = tasks with no dependencies and no mutual collisions.
2. Wave N = tasks whose blockers have all landed in earlier waves, again mutually collision-free.
3. Two tasks that collide **never share a wave** — serialize them across waves, re-cut one along a module seam (the Architect advises where), or merge them into one task.
4. Prefer more, smaller waves over risky big ones; a wave is only as fast as its slowest group anyway.

The DAG's facts are the Architect's; these calls — order, priority, re-cuts — are the PM's.

**Which waves have seams is the Architect's Pass 2 finding, not a judgement call:** it names every pair of tasks in one wave where one consumes the other's output, and each seam it names obliges the two rules below. Then, before **every** fan-out — single-wave missions included — the PM opens the wave: `mp wave open W<n>`. It refuses while a DRIFT stands or the SUSPICION ratchet is fired, and a TaskSpec will not seal into a wave that is not open.

## Isolation and integration

- **Same-branch parallel groups** are safe only when the Architect confirmed disjoint files. When in doubt — or when the principal wants a hard guarantee — give each group its own **git worktree** on its own task branch, forked from the mission branch.
- **Fork after the specs exist.** Create worktrees only after the mission's ledger entries (specs, registry line) are in place, so every group starts from a complete picture.
- **Integrate per wave:** as each group's Stabilizer reports accept, merge its task branch back into the mission branch; resolve escalations before launching the wave that depended on that task.
- **Seams are payload contracts, never prose.** When two groups in one wave consume each other's output, the seam is frozen BEFORE the fork as a shared contract file owned by one task (or the PM) — signatures, types, the exact spelling of every value that crosses, and one worked example — and both specs cite it by section. A seam agreed in two specs' prose is a seam a merge breaks silently: each group tests against a double of the other, both suites go green, and the merged whole does not work.
- **The integration round.** A wave whose groups share a seam does not end at the merge: the merge is its own bounded round (spec → constructor → crititor → group report) whose acceptance criterion is a **real-objects end-to-end proof through every seam** — the counterparties real, no doubles across the seam, the result observed in the store. Batteries green after each merge are necessary and never sufficient: they prove each half in isolation. A wave with no cross-group seam needs no integration round; say so in the Integration Note. The wave's calibration cell runs after the integration round, not before it.
- **Cleanup rule:** never delete a worktree or task branch until its work is merged (or deliberately discarded with the principal's knowledge) — and its ledger artifacts exist at the anchored ledger path (see `references/ledger.md`). Code travels through git; paperwork travels through the ledger; a deleted worktree must strand neither.

## Handoffs into a group

Every spawned agent gets absolute paths to: its role file (skill `roles/`), PROJECT.md, the task spec — plus, for worktree groups, the worktree path and branch name, and always the anchored ledger path. Sub-agents inherit nothing implicitly; if it isn't in the handoff, it doesn't reach them. The spec's mandatory-reading list is an input for the **whole group** — the Crititor and Stabilizer read it too, not just the Constructor.

## Between waves

After each wave: read every GroupReport, integrate accepts, decide escalations (re-plan / re-scope / one more scoped round / take to the principal), and write the wave's **Integration Note** (template: `templates/integration-note.md`) — merges, escalation decisions, an explicit disposition for every flag the wave's documents raised (engine invariant 11; the flags are derived, so the ledger already holds them by id), and the footprint reconciliation: ArchPlan predictions vs the files the dev reports actually touched, with deviations feeding the next DAG. **Sealing the Note closes the wave.** Refresh the Architect's DAG only if the task set changed materially, then open and launch the next wave. Report to the principal at natural checkpoints — wave boundaries, not every round.
