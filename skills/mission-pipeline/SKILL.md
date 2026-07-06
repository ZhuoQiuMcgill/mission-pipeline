---
name: mission-pipeline
description: "Human-in-the-loop multi-agent engineering workflow: a PM agent aligns with the principal, decomposes a mission into tasks, fans them out to parallel groups (Constructor builds, Crititor reviews, Stabilizer judges a bounded loop), schedules waves via a read-only Architect, and closes only on the principal's hands-on sign-off. Use when the user asks to run a mission, install or set up this pipeline in a project, spawn the role team (PM / Architect / Constructor / Crititor / Stabilizer / Researcher), run a build–critique–stabilize loop, or coordinate multi-task parallel development. First run in a project: follow references/setup.md."
---

# Mission Pipeline

An operating playbook for running engineering work through a team of specialist agents with a human principal in the loop. This file is the engine spine — read it fully when the skill triggers.

**Precedence:** if the host project already runs this pipeline natively (its own role documents, e.g. under `.claude/roles/`), those govern and this skill defers. Otherwise this skill is the engine, and the project binds to it only through `.claude/mission-pipeline/PROJECT.md` (see *Binding contract*).

**Engine files are read-only.** Never edit this skill's files inside a host project. Project-specific rules live in PROJECT.md; upgrades replace engine files wholesale.

## Concepts

| Term | Meaning |
|---|---|
| **Principal** | The human. Owns the vision, makes final calls, closes missions by hands-on sign-off. |
| **PM** | The hub agent between the principal and all specialists. Translates intent into plans; owns the *how*. Usually the agent reading this file. |
| **Mission** | A coherent goal *plus the principal's acceptance of it*. The unit of work. Everything is a mission — even a one-task fix. |
| **Task** | One self-contained work order inside a mission, ID `T1…Tn` (mission-scoped). |
| **Group** | One task's execution cell: Constructor + Crititor + Stabilizer running a bounded loop. One group = one task. |
| **Wave** | A set of groups safe to run in parallel (disjoint files, no unmet dependencies). |
| **Ledger** | The pipeline's paper trail on disk. All artifacts go there — see `references/ledger.md`. |

## The cast

Role files live in this skill's `roles/` directory. When spawning an agent, point it (absolute paths) at its role file + PROJECT.md + its task spec — nothing else is guaranteed to reach it.

| Role | One line | Spawned by |
|---|---|---|
| PM (`roles/pm.md`) | Aligns, designs, decomposes, schedules, integrates, reports. Never builds. | Principal |
| Architect (`roles/architect.md`) | Read-only recon → structural map; then task list → parallel/blocker DAG. Proposes; PM disposes. | PM |
| Constructor (`roles/constructor.md`) | Builds + tests exactly to the task spec. | PM (into a group) |
| Crititor (`roles/crititor.md`) | Critiques the delivery against acceptance criteria → `PASS` / `CHANGES-REQUESTED`. | PM (into a group) |
| Stabilizer (`roles/stabilizer.md`) | The PM's judgment inside one group: judges the verdict, loops or escalates. | PM (into a group) |
| Researcher (`roles/researcher.md`) | Optional. Adversarial external evidence before a decision. | Per PROJECT.md (default: principal, separate session) |

## Mission lifecycle

1. **Kickoff check.** Settle with the principal: *new mission, or continuation of an open one?* Feedback on work just delivered continues the same mission — it was never closed.
2. **Align.** Restate the goal plainly; offer candidates when direction is open; never lock direction without the principal's confirmation. Detour to the Researcher if a decision needs evidence first.
3. **Claim the mission.** Pick the name per PROJECT.md's mission-name scheme — typically `Week<NN>-<MissionName>`, where the week comes from the scheme settled at setup, **never invented** (no scheme recorded yet → resolve it first, `references/setup.md` §9). Register it in the ledger's `MISSIONS.md`, create the mission folder skeleton. Read `references/ledger.md` before writing anything.
4. **Explore** *(large missions)*. Spawn the Architect → structural map (Pass 1). Read it before designing.
5. **Design & decompose.** Write the design decision into the mission's `design/`, then one task spec per task into `tasks/` (template: `templates/task-spec.md`).
6. **Schedule** *(large missions)*. Same Architect, Pass 2 → dependency/collision DAG grouped into waves. Its findings are facts; the wave order and collision resolutions are the PM's call. Read `references/parallel.md` before fanning out.
7. **Execute in waves.** One group per task; groups in a wave run in parallel. Each group runs the loop below and reports via its Stabilizer.
8. **Integrate & report.** Judge each group report (accept → integrate; escalation → decide: re-plan, re-scope, one more scoped round, or take to the principal). Launch the next wave. When the last wave lands, report the outcome to the principal — high-level, honest about failures.
9. **Close only on sign-off.** The principal tries the result. Problems found re-enter the same mission as new rounds or new tasks. Only the principal's acceptance closes the mission (mark it in `MISSIONS.md`).

**Small-mission degradation:** for a couple of tasks, skip the Architect and separate Stabilizers — the PM holds the Stabilizer seat and runs the loop directly. Everything else (mission folder, task specs, the loop bounds) still applies.

## The group loop (max N rounds; default N=3)

```
task spec ──▶ CONSTRUCTOR builds + tests ──▶ report
                    ▲                          │
                    │                          ▼
             send back with critique     CRITITOR critiques vs acceptance criteria
                    │                          │  verdict: PASS / CHANGES-REQUESTED
                    │                          ▼
                    └──────────────── STABILIZER judges:
                        PASS                → accept, group report to PM  ✓
                        CHANGES, round < N  → send back (same task ID, bump versions)
                        CHANGES, round = N  → stop, escalate to PM  ⚠
                        Constructor blocked → escalate to PM (spec problems are the PM's)
```

- **Verdict ≠ judgment.** The Crititor renders the verdict; the Stabilizer (or the PM holding the seat) decides what happens. Neither builds; neither re-reviews.
- **Escalation ladder:** Stabilizer → PM → principal. Each level exhausts its options before passing up; nobody skips a level; nobody loops past the bound.
- Every round's artifacts go to the ledger under the mission, keyed by `T<n>`, versions bumped per round.

## Invariants — the engine, not configuration

Changing any of these is forking the methodology, not configuring it:

1. **Separate hands.** Build, critique, and judgment are three different agents (or seats). No self-review, no judge edits.
2. **Align first.** No direction locked without the principal's confirmation.
3. **Verdict ≠ judgment.** Critique produces evidence and a verdict; the Stabilizer/PM decides.
4. **Bounded rounds, then escalate.** Never loop past the round cap; never accept failing work to force a close.
5. **Out-of-scope is mandatory.** A task spec without an explicit out-of-scope list is unfinished.
6. **Undeclared deviation = automatic fail**, regardless of code quality.
7. **One voice per group.** Everything a group says upward goes through its Stabilizer.
8. **Architect proposes; PM disposes.** Code facts are the Architect's; decisions are the PM's.
9. **Principal's sign-off closes the mission.** Integration and reporting do not.

## Binding contract

`.claude/mission-pipeline/PROJECT.md` (created at setup from `templates/PROJECT.md`) is the **only** file a project edits. It fills declared slots — principal, ground-rule docs, tech constraints, verification commands, model picks, round cap, naming prefix, ledger location — and may add project rules. It may **not** restate or override the lifecycle, the loop, or the invariants. On any conflict, the engine wins.

## References

- `references/setup.md` — **first run in a project**: install steps + the setup interview that fills PROJECT.md.
- `references/ledger.md` — ledger location, layout, naming, and the path-anchoring rule. **Read before writing any artifact.**
- `references/parallel.md` — waves, collision handling, worktree discipline. **Read before fanning out groups.**
- `templates/` — artifact templates: task-spec, dev-report, critique, group-report, arch-plan, missions-registry, PROJECT.md.
