---
name: mission-pipeline
description: "Human-in-the-loop multi-agent engineering workflow: a PM agent aligns with the principal, decomposes a mission into tasks, fans them out to parallel groups (Constructor builds, Crititor reviews, Stabilizer judges a bounded loop), schedules waves via a read-only Architect, and closes only on the principal's hands-on sign-off after a full-scope closing gate. Use when the user asks to run a mission, install or set up this pipeline in a project, spawn the role team (PM / Architect / Constructor / Crititor / Stabilizer / Calibrator / Challenger / Researcher / Auditor), run a build–critique–stabilize loop, calibrate a running mission against its frozen Charter, or coordinate multi-task parallel development. First run in a project: follow references/setup.md."
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
| **Wave** | A set of groups safe to run in parallel (disjoint files, no unmet dependencies). Opened by `mp wave open W<n>` — one call per wave, single-wave missions included — and closed when its Integration Note seals. |
| **Ledger** | The pipeline's paper trail on disk. All artifacts go there — see `references/ledger.md`. |
| **Run** | One recorded execution of a verification command. Whoever executes it records it once (`mp run record --cmd … --log …`, `--tree` in a worktree) and gets a `run:<id>`; every other seat **cites the id instead of re-running**. A run binds to the tree it judged. |
| **Live record** | Every derived record is *live* until superseded — by `mp supersede` (the principal's word, or reality), or automatically by the next sealed version of its document. **Rules read live records only**; superseded ones stay in the journal as history, and whatever depended on one turns up in `mp worklist`. |
| **Standing contract** | A ratified project invariant in the ledger's `CONTRACTS.md`. Binds every task like an acceptance criterion — whether or not the spec restates it — until the principal retires it. Charter prohibitions become standing contracts when the Charter seals. |
| **Out-of-frame flag** | A routed observation about the **product** or the **principal's intent** that no document covers. Derived from the document that raises it; never feeds a verdict; reaches the PM verbatim and gets an explicit disposition. Silence is not disposal. |
| **Engine relay** | The upstream channel for observations about the **pipeline itself** — the engine, the ledger, the substrate. Filed in a document's `## Engine relay` section, derived at seal, exported with `mp relay export`. Paperwork about paperwork goes here, so the flag ledger stays about the product. |
| **Charter** | The mission's frozen calibration basis: the goal in the principal's own words, sealed before decomposition. Only the principal amends it, and an amendment is a **new Charter file at the next version** — never an edit in place. Divergence without principal-anchored written authorization **is** drift, by definition. |
| **Calibration cell** | A drift check against the sealed Charter. The starved **Calibrator runs alone first**; only an anchored accusation convenes the fed Challenger and the Arbiter, who rules **ALIGNED / SUSPICION / DRIFT**. Aggregate cell per wave boundary; task cell on trigger only. See *Calibration — the five layers*. |
| **Evidence types** | Every criteria row in a verdict-bearing artifact carries one typed anchor: **R** `run:<id>` (reality — a recorded run) · **F** `charter:v<N>` / `contract:<id>` / `project:<section>` (fixed point, frozen before the mission web) · **D** `artifact:<id>` (derived — a mission-era document) · **X** a verified URL. D-only agreement is worth zero (invariant 13). See `references/substrate.md`. |

## The cast

Role files live in this skill's `roles/` directory. When spawning an agent, point it (absolute paths) at its role file + PROJECT.md + its task spec — nothing else is guaranteed to reach it.

| Role | One line | Spawned by |
|---|---|---|
| PM (`roles/pm.md`) | Aligns, designs, decomposes, schedules, integrates, reports. Never builds. | Principal |
| Architect (`roles/architect.md`) | Read-only recon → structural map; then task list → parallel/blocker DAG, **seam detection**, and cold spec lint. Proposes; PM disposes. | PM |
| Constructor (`roles/constructor.md`) | Builds + tests exactly to the task spec; records its runs. | PM (into a group) |
| Crititor (`roles/crititor.md`) | Critiques the delivery against acceptance criteria and their written purposes → `PASS` / `CHANGES-REQUESTED`. | PM (into a group) |
| Stabilizer (`roles/stabilizer.md`) | The PM's judgment inside one group: spot-checks that the evidence says what is claimed, judges the verdict, loops or escalates. | PM (into a group) |
| Researcher (`roles/researcher.md`) | Optional. Adversarial external evidence before a decision. | Per PROJECT.md (default: PM-spawned fresh context, engine-fixed request; principal-run available as a binding) |
| Auditor (`roles/auditor.md`) | Optional. One arms-length read before sign-off: does the integrated result deliver the written goal? | Per PROJECT.md (default: PM-spawned fresh context, artifacts-only inputs; principal-run available as a binding; a different model family preferred when available, never required) |
| Calibrator (`roles/calibrator.md`) | The starved seat: accuses drift from the sealed Charter and `mp metrics` alone. **Runs alone first** — with no anchored accusation it writes the wave's ALIGNED verdict itself and the cell ends there. | PM — inputs engine-fixed via `mp calib bundle` |
| Challenger (`roles/challenger.md`) | The fed seat: discharges each accusation with principal-anchored written authorization, or concedes. **Convened only after an anchored accusation exists.** | PM — inputs engine-fixed via `mp calib bundle` |

The cell's **Arbiter** is the Stabilizer role in a scoped seat (`roles/stabilizer.md`, *Arbiter seat*), convened with the Challenger — never any build group's Stabilizer in the same mission; a different model family preferred when available, never required.

## What agents never do by hand

Agents write documents; the engine derives the records. Every seat writes its artifact once, then submits it with a single call — `python3 <skill>/scripts/mp seal <path>` — and `mp` derives everything the ledger needs from the text: the artifact's identity from the `mp:header` block, evidence rows from the criteria table, flags from the Out-of-frame and Noticed-but-not-fixed sections, relay items from `## Engine relay`, the verdict, the round, the edges, the Integration Note's dispositions. **Nothing in the ledger is typed twice.** Rules run at seal — the one step nobody can skip — and a document that breaks one is REFUSED with the rule named: fix the document and seal again. A refusal is the engine speaking; never route around it (`references/substrate.md`).

## Mission lifecycle

1. **Kickoff check.** Settle with the principal: *new mission, or continuation of an open one?* Feedback on work just delivered continues the same mission — it was never closed.
2. **Align.** Restate the goal plainly; offer candidates when direction is open; never lock direction without the principal's confirmation. **Read back frame-level directives:** when the principal sets or changes verification policy, scope, a contract, a closure condition, or the round cap, read back the compiled policy — scope and boundary, two lines or less — and get confirmation before it enters any document. Detour to the Researcher if a decision needs evidence first.
3. **Claim the mission.** Pick the name per PROJECT.md's mission-name scheme — typically `Week<NN>-<MissionName>`, where the week comes from the scheme settled at setup, **never invented** (no scheme recorded yet → resolve it first, `references/setup.md` §9). Resolve PROJECT.md's **Document map** if any slot in it is unset — never fan out without it. Claim the mission (`mp mission claim` — atomic; it derives the `MISSIONS.md` line), create the mission folder skeleton. Read `references/ledger.md` before writing anything. **Write and seal the Charter** (template: `templates/charter.md`) before decomposition — a mission may not fan out without a sealed Charter. **Sealing it ratifies its `## Prohibitions` bullets into standing contracts automatically** — one act, zero extra principal interaction. From sealing on, only the principal amends it, and an amendment is a **new Charter file at the next version**, carrying the principal's verbatim words in its amendment ledger.
4. **Explore** *(large missions)*. Spawn the Architect → structural map (Pass 1). Read it before designing.
5. **Design & decompose.** Write the design decision into the location the Document map names (default: the mission's `design/`), then one task spec per task into `tasks/` (template: `templates/task-spec.md`). Every spec declares its **wave** and whether it **touches a contract** — both are header fields, and both are read by the engine.
6. **Schedule & veto** *(large missions)*. Same Architect, Pass 2 → dependency/collision DAG grouped into waves, **seam detection** (tasks that consume each other's output), and **the cold spec lint** (pointer requirements, unanchorable criteria, Charter contradictions, verification-scope regression, missing out-of-scope) plus **unstated assumptions**. The DAG's facts are the Architect's; the wave order and collision resolutions are the PM's. Then the **delta veto**: surface the lint and assumption findings to the principal **one item at a time, most critical first** — a top-level misalignment invalidates everything after it. Resolve each before showing the next; stop when the principal says proceed or the items stop being frame-level. Read `references/parallel.md` before fanning out — a wave with a seam gets a frozen seam contract and an integration round.
7. **Execute in waves.** **`mp wave open W<n> --mission <name> --tasks …` before every fan-out** — one call per wave, single-wave missions included. It refuses while a DRIFT stands or the SUSPICION ratchet is fired; only the principal clears that. Then seal each TaskSpec (`mp seal` — refused if its wave is not open or its out-of-scope list is empty) and spawn one group per task; groups in a wave run in parallel. Each group runs the loop below and reports via its Stabilizer.
8. **Integrate & report.** Run **`mp calib triggers`** at each Crititor `PASS` — the engine, not the PM, says which tasks earned a task-level cell — and convene those cells Calibrator-first, before that group's Stabilizer accepts. Judge each group report (accept → integrate; escalation → decide: re-plan, re-scope, one more scoped round, or take to the principal). Then the wave boundary: re-ground against the Charter (the ritual in `roles/pm.md`), spawn the **aggregate calibration cell** (missions of ≥2 waves) Calibrator-first, inputs engine-fixed via `mp calib bundle`, and write the wave's **Integration Note** (template: `templates/integration-note.md`): merges, escalation decisions, **an explicit disposition for every flag**, the re-grounding and compaction lines, the wave's verdict, `mp acts --mission` output, the footprint reconciliation. **Sealing the Note closes the wave.** Route on the verdict — **ALIGNED** → open the next wave; **SUSPICION** → disposition each incomplete chain; **DRIFT** → the affected fan-out is halted mechanically and the principal hears it at their next natural appearance, in goal language. When the last wave lands, report the outcome — high-level, honest about failures.
9. **Close only on sign-off.** Before presenting the mission: run the **closing gate** — the full-scope verification PROJECT.md names — over the integrated result (task-level verification may have been narrowed; this gate may not) and record it, `mp run record … --scope closing`. Re-check the standing contracts, and, when enabled, hand the mission to the **Auditor** for its arms-length read. The principal receives the outcome, the flag ledger, the gate output, the Closure Audit, and the **repudiation list** — `mp acts --mission`, every act executed in their name, repudiable item by item — then tries the result. Problems found re-enter the same mission as new rounds or new tasks. **Only the principal's acceptance closes the mission**, and the PM records that acceptance with **`mp gate close`** — the act that marks the mission closed, and that refuses while any flag is undisposed, any lint failure stands, the closing run does not match the integrated tree, or the Charter is stale. Then ratify any drafted standing-contract entries and send the mission's engine observations upstream with `mp relay export`.

**Small-mission degradation:** for a couple of tasks, skip the Architect and separate Stabilizers — the PM holds the Stabilizer seat and runs the loop directly. Everything else (mission folder, task specs, the loop bounds, flag routing, the closing gate) still applies, and **one wave is still opened** — `mp wave open W1` — because that is where the calibration verdicts get their teeth. The Charter is still mandatory: a one-line fix mission has a one-paragraph Charter. Single-wave missions skip the aggregate calibration cell: the Auditor and the closing gate cover mission-end.

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
- **One run, many citations.** Whoever executes a verification records it once (`mp run record`); every other seat cites `run:<id>`. Re-run only to *dispute* a run — and record the re-run as its own, saying what it disputes.
- **Accept only checked evidence.** Whether anchors *resolve* is the engine's job: `mp seal` refuses a row anchored to a run that does not exist, a "met" resting only on derived evidence, or a citation of a summary. Whether the cited thing **says what is claimed** is the Stabilizer's spot-check before any accept. Judging paperwork is not re-reviewing.
- **Flags are derived, not carried.** Every critique carries an Out-of-frame risk; every report carries Noticed-but-not-fixed. Both enter the flag ledger when the document seals — no seat re-types them, and the group report has no flag section. The PM dispositions each by id. Flags never change a verdict.
- **Escalation ladder:** Stabilizer → PM → principal. Each level exhausts its options before passing up; nobody skips a level; nobody loops past the bound.
- Every round's artifacts go to the ledger under the mission, keyed by `T<n>`, versions bumped per round.

## Calibration — the five layers

Long missions drift by legal steps: no per-step check sees a trend, and agreement among derived documents corroborates nothing (invariant 13). The sealed Charter is the fixed point; five layers defend it:

| Layer | Defense | When | Catches |
|---|---|---|---|
| L1 | Charter prohibitions, ratified into standing contracts at sealing | every task, every round | slice-judgeable violations — the Crititor already checks the registry |
| L2 | Architect Pass 2 **Charter-lint** | before fan-out | specs or criteria contradicting a Charter line |
| L3 | Task-level calibration cell | on trigger only (`mp calib triggers`) | delivery-level divergence in high-risk tasks |
| L4 | PM **re-grounding ritual** | every wave boundary | drift *production* (compaction) — the only preventive layer |
| L5 | **Aggregate calibration cell** — the main force | every wave boundary | monotone narrowing; task-set ≠ goal |

- **Calibrator first, the rest only on cause.** The Calibrator runs **alone**. If it files **no anchored accusation**, that *is* the wave's verdict: it writes the CalibrationVerdict itself — ALIGNED, `## Convened: calibrator-only` — and the cell is over. Only an anchored accusation convenes the Challenger and the Arbiter (`## Convened: full`). One cell, one verdict artifact; a cheap cell is the normal case.
- **Two legal accusation shapes, nothing else:** *trend* (must cite `mp metrics` output) and *contradiction* (must quote a Charter line). Anything unanchored is a Note. So is anything whose subject is a **ledger artifact** — a wrong section label, a stale pointer, a count in another document: that is paperwork, not drift in the work, and it belongs in Notes or `## Engine relay`. Absolute coverage — "the tasks don't add up to the goal *yet*" — is the Auditor's question at close, never the cell's.
- **Verdicts have teeth, and the engine outranks the project.** `mp wave open` **refuses** while a DRIFT stands, or while two consecutive SUSPICION verdicts stand (the ratchet). Only the principal clears one: the PM runs `mp supersede verdict:<id> --by principal --reason "<their verbatim words>"` on their word, recorded verbatim and listed in `mp acts`. **No standing contract, project rule, or PROJECT.md binding overrides this** — a project rule that says "do not stop" does not outrank a calibration halt; the collision itself is what the principal is shown. DRIFT halts the affected fan-out only; unaffected work continues.
- **Task-cell triggers are computed, not remembered.** `mp calib triggers` reports them; the PM never checks by hand. They are: a **recovery task** (the spec's `recovers:` field) · a spec sealed **after a Charter amendment** · a `PASS` arriving **at the round cap** · a spec sealed **after a compaction** — bounded: only for specs sealed after the compaction and before the next completed re-grounding, and only when the spec's `touches-contract` is `yes`. *Touches a contract* means the task changes something other tasks or the product depend on — an interface, a data shape, a verification path; a prose-only or records-only task does not. Contradiction shape only (a single slice has no trend). The cell interposes between a Crititor `PASS` and the Stabilizer's accept; a DRIFT enters the loop as an external binding fact the Crititor cites → automatic `CHANGES-REQUESTED`. Cell rounds never consume the group's round budget.
- **Inputs are engine-fixed:** every seat reads exactly what `mp calib bundle` assembles by rule from the ledger. The PM spawns the cell and reads its verdict — never curates, filters, or supplements what it sees.

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
12. **The principal converses; agents operate.** Every principal decision must be expressible and deliverable in one plain sentence. Any pipeline step that requires the principal to execute an instruction, operate a tool, or absorb machinery detail is an engine defect, not a configuration option.
13. **Echoes are not evidence.** Agreement among derived artifacts adds no evidential weight. No acceptance stands without at least one reality-anchored or fixed-point anchor, and reality anchors bind to the source state that produced them.

## Binding contract

`.claude/mission-pipeline/PROJECT.md` (created at setup from `templates/PROJECT.md`) is the **only** file a project edits. It fills declared slots — principal, ground-rule docs, the document map (mission-rationale location, standing-contracts registry), tech constraints, verification commands and the closing gate, commit policy, model picks, round cap, naming prefix, ledger location, Researcher and Auditor bindings — and may add project rules. It may **not** restate or override the lifecycle, the loop, or the invariants. On any conflict, the engine wins — including over a standing contract that would absorb a calibration halt.

## References

- `references/setup.md` — **first run in a project**: install steps + the setup interview that fills PROJECT.md.
- `references/ledger.md` — ledger location, layout, naming, the artifact-is-the-event model, and the path-anchoring rule. **Read before writing any artifact.**
- `references/parallel.md` — waves, collision handling, worktree discipline, seam contracts and the integration round. **Read before fanning out groups.**
- `references/substrate.md` — the deterministic substrate and the `mp` toolbelt (invoked `python3 <skill>/scripts/mp …`): the document contract, the seal, runs, supersession, the command surface. **Read before any `mp` command.** **Agent-internal — the principal never runs `mp` (invariant 12).**
- `templates/` — artifact templates: charter, task-spec, dev-report, critique, group-report, arch-plan, integration-note, calibration-verdict, closure-audit, standing-contracts, missions-registry, PROJECT.md.
