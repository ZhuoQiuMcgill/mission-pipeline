---
name: mission-pipeline
description: "Human-in-the-loop multi-agent engineering workflow: a PM agent aligns with the principal, decomposes a mission into tasks, fans them out to parallel groups (Constructor builds, Crititor reviews, Stabilizer judges a bounded loop), schedules waves via a read-only Architect, and closes only on the principal's hands-on sign-off after a full-scope closing gate. Use when the user asks to run a mission, install or set up this pipeline in a project, spawn the role team (PM / Architect / Constructor / Crititor / Stabilizer / Researcher / Auditor), run a build–critique–stabilize loop, or coordinate multi-task parallel development. First run in a project: follow references/setup.md."
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
| **Standing contract** | A ratified project invariant in the ledger's `CONTRACTS.md`. Binds every task like an acceptance criterion — whether or not the spec restates it — until the principal retires it. |
| **Out-of-frame flag** | A routed observation about something no document covers. Never feeds a verdict; always reaches the PM verbatim and gets an explicit disposition. Silence is not disposal. |

## The cast

Role files live in this skill's `roles/` directory. When spawning an agent, point it (absolute paths) at its role file + PROJECT.md + its task spec — nothing else is guaranteed to reach it.

| Role | One line | Spawned by |
|---|---|---|
| PM (`roles/pm.md`) | Aligns, designs, decomposes, schedules, integrates, reports. Never builds. | Principal |
| Architect (`roles/architect.md`) | Read-only recon → structural map; then task list → parallel/blocker DAG + cold spec lint. Proposes; PM disposes. | PM |
| Constructor (`roles/constructor.md`) | Builds + tests exactly to the task spec. | PM (into a group) |
| Crititor (`roles/crititor.md`) | Critiques the delivery against acceptance criteria and their written purposes → `PASS` / `CHANGES-REQUESTED`. | PM (into a group) |
| Stabilizer (`roles/stabilizer.md`) | The PM's judgment inside one group: spot-checks the evidence, judges the verdict, loops or escalates. | PM (into a group) |
| Researcher (`roles/researcher.md`) | Optional. Adversarial external evidence before a decision. | Per PROJECT.md (default: principal, separate session) |
| Auditor (`roles/auditor.md`) | Optional. One arms-length read before sign-off: does the integrated result deliver the written goal? | Per PROJECT.md (default: principal, separate session; a different model family preferred when available, never required) |

## Mission lifecycle

1. **Kickoff check.** Settle with the principal: *new mission, or continuation of an open one?* Feedback on work just delivered continues the same mission — it was never closed.
2. **Align.** Restate the goal plainly; offer candidates when direction is open; never lock direction without the principal's confirmation. **Read back frame-level directives:** when the principal sets or changes verification policy, scope, a contract, a closure condition, or the round cap, read back the compiled policy — scope and boundary, two lines or less — and get confirmation before it enters any document. Detour to the Researcher if a decision needs evidence first.
3. **Claim the mission.** Pick the name per PROJECT.md's mission-name scheme — typically `Week<NN>-<MissionName>`, where the week comes from the scheme settled at setup, **never invented** (no scheme recorded yet → resolve it first, `references/setup.md` §9). Resolve PROJECT.md's **Document map** if any slot in it is unset — never fan out without it. Register the mission in the ledger's `MISSIONS.md`, create the mission folder skeleton. Read `references/ledger.md` before writing anything.
4. **Explore** *(large missions)*. Spawn the Architect → structural map (Pass 1). Read it before designing.
5. **Design & decompose.** Write the design decision into the location the Document map names (default: the mission's `design/`), then one task spec per task into `tasks/` (template: `templates/task-spec.md`).
6. **Schedule & veto** *(large missions)*. Same Architect, Pass 2 → dependency/collision DAG grouped into waves, **plus the cold spec lint** (pointer requirements, unanchorable criteria, verification-scope regression, missing out-of-scope) and **unstated assumptions**. The DAG's facts are the Architect's; the wave order and collision resolutions are the PM's. Then the **delta veto**: surface the lint and assumption findings to the principal **one item at a time, most critical first** — a top-level misalignment invalidates everything after it. Resolve each before showing the next; stop when the principal says proceed or the items stop being frame-level. Read `references/parallel.md` before fanning out.
7. **Execute in waves.** One group per task; groups in a wave run in parallel. Each group runs the loop below and reports via its Stabilizer. Flags travel with the reports.
8. **Integrate & report.** Judge each group report (accept → integrate; escalation → decide: re-plan, re-scope, one more scoped round, or take to the principal). Write the wave's **Integration Note** (template: `templates/integration-note.md`): merges, escalation decisions, **an explicit disposition for every flag**, and the footprint reconciliation (ArchPlan predictions vs files actually touched). Launch the next wave. When the last wave lands, report the outcome to the principal — high-level, honest about failures.
9. **Close only on sign-off.** Before presenting the mission: run the **closing gate** — the full-scope verification PROJECT.md names — over the integrated result (task-level verification may have been narrowed; this gate may not), re-check the standing contracts, and, when enabled, hand the mission to the **Auditor** for its arms-length read. The principal receives the outcome, the flag ledger, the gate output, and the Closure Audit — then tries the result. Problems found re-enter the same mission as new rounds or new tasks. Only the principal's acceptance closes the mission (mark it in `MISSIONS.md`; ratify any drafted standing-contract entries).

**Small-mission degradation:** for a couple of tasks, skip the Architect and separate Stabilizers — the PM holds the Stabilizer seat and runs the loop directly. Everything else (mission folder, task specs, the loop bounds, flag routing, the closing gate) still applies.

## The group loop (max N rounds; default N=3)

```
task spec ──▶ CONSTRUCTOR builds + tests ──▶ report
                    ▲                          │
                    │                          ▼
             send back with critique     CRITITOR critiques vs acceptance criteria
                    │                          │  verdict: PASS / CHANGES-REQUESTED
                    │                          ▼
                    └──────────────── STABILIZER judges:
                        PASS, spot-check clean  → accept, group report to PM  ✓
                        PASS, spot-check fails  → critique back to CRITITOR (same round)
                        CHANGES, round < N      → send back (same task ID, bump versions)
                        CHANGES, round = N      → stop, escalate to PM  ⚠
                        Constructor blocked     → escalate to PM (spec problems are the PM's)
```

- **Verdict ≠ judgment.** The Crititor renders the verdict; the Stabilizer (or the PM holding the seat) decides what happens. Neither builds; neither re-reviews.
- **Accept only checked evidence.** Before any accept, the Stabilizer samples the critique's evidence chain — cited `file:line` exists and says what is claimed; cited tests/commands re-run green. Judging paperwork is not re-reviewing.
- **Flags travel.** Every critique carries an Out-of-frame risk entry; every report carries Noticed-but-not-fixed. The Stabilizer carries them verbatim; the PM dispositions each. Flags never change a verdict.
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
10. **Reality closes the evidence.** No mission reaches sign-off without one full-scope verification run over the integrated result. Task-level verification may be narrowed for speed; the closing gate may not.
11. **Flags route; silence is not disposal.** Out-of-frame flags and noticed-but-not-fixed items reach the PM verbatim, and each receives an explicit, recorded disposition.

## Binding contract

`.claude/mission-pipeline/PROJECT.md` (created at setup from `templates/PROJECT.md`) is the **only** file a project edits. It fills declared slots — principal, ground-rule docs, the document map (mission-rationale location, standing-contracts registry), tech constraints, verification commands and the closing gate, commit policy, model picks, round cap, naming prefix, ledger location, Researcher and Auditor bindings — and may add project rules. It may **not** restate or override the lifecycle, the loop, or the invariants. On any conflict, the engine wins.

## References

- `references/setup.md` — **first run in a project**: install steps + the setup interview that fills PROJECT.md.
- `references/ledger.md` — ledger location, layout, naming, and the path-anchoring rule. **Read before writing any artifact.**
- `references/parallel.md` — waves, collision handling, worktree discipline. **Read before fanning out groups.**
- `templates/` — artifact templates: task-spec, dev-report, critique, group-report, arch-plan, integration-note, closure-audit, standing-contracts, missions-registry, PROJECT.md.
