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

## Isolation and integration

- **Same-branch parallel groups** are safe only when the Architect confirmed disjoint files. When in doubt — or when the principal wants a hard guarantee — give each group its own **git worktree** on its own task branch, forked from the mission branch.
- **Fork after the specs exist.** Create worktrees only after the mission's ledger entries (specs, registry line) are in place, so every group starts from a complete picture.
- **Integrate per wave:** as each group's Stabilizer reports accept, merge its task branch back into the mission branch; resolve escalations before launching the wave that depended on that task.
- **Cleanup rule:** never delete a worktree or task branch until its work is merged (or deliberately discarded with the principal's knowledge) — and its ledger artifacts exist at the anchored ledger path (see `references/ledger.md`). Code travels through git; paperwork travels through the ledger; a deleted worktree must strand neither.

## Handoffs into a group

Every spawned agent gets absolute paths to: its role file (skill `roles/`), PROJECT.md, the task spec — plus, for worktree groups, the worktree path and branch name, and always the anchored ledger path. Sub-agents inherit nothing implicitly; if it isn't in the handoff, it doesn't reach them.

## Between waves

After each wave: read every GroupReport, integrate accepts, decide escalations (re-plan / re-scope / one more scoped round / take to the principal), refresh the Architect's DAG only if the task set changed materially, then launch the next wave. Report to the principal at natural checkpoints — wave boundaries, not every round.
