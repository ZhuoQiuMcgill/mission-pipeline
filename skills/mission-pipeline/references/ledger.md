# The Ledger — where every artifact lives

The ledger is the pipeline's paper trail: operational state, deliberately **outside** the host project's source tree and outside the skill folder. Read this before writing any artifact.

## Locations — two, strictly separated

```
<project>/.claude/skills/mission-pipeline/   ← THE SKILL: engine, read-only, what gets copied between projects
<project>/.claude/mission-pipeline/          ← RUNTIME STATE: this project's bindings + paper trail, never copied
├── PROJECT.md                               ←   the binding layer (from templates/PROJECT.md at setup)
└── ledger/
    ├── MISSIONS.md                          ←   registry: one line per mission (derived by mp mission claim)
    ├── CONTRACTS.md                         ←   standing contracts (from templates/standing-contracts.md at setup)
    ├── events.jsonl · mp.db                 ←   the substrate: journal (authoritative) + derived DB (references/substrate.md)
    └── Week<NN>-<MissionName>/              ←   one folder per mission
        ├── Charter / IntegrationNote /      #   mission-level artifacts, at the folder root
        │   CalibrationVerdict / ClosureAudit
        ├── design/        # DesignDoc — what was decided and why (unless the Document map points elsewhere)
        ├── architect/     # ArchPlan — map + DAG (large missions)
        ├── tasks/         # TaskSpec — one per task; seam contracts for a wave that has one
        ├── constructor/   # DevReport — one per task per round
        ├── critic/        # Critique — one per task per round
        ├── stabilizer/    # GroupReport — one per task
        └── research/      # ResearchRequest / ResearchResult / ResearchTrail (only if the detour ran)
```

State lives outside the skill folder so that copying the skill to another project can never drag mission history along. PROJECT.md may relocate the ledger (e.g. into a tracked `docs/` tree) — the layout below it stays identical. Likewise, PROJECT.md's **Document map** may point mission rationale (design decisions) at the project's own existing tree — mid-pipeline adoptions keep their docs where they are; the slot, not the folder, is authoritative.

## The artifact is the event

A document is not a description of what happened; **it is what happened.** Write it once, seal it with one call — `python3 <skill>/scripts/mp seal <path>` — and the engine derives every record from the text: the artifact, its evidence rows, its flags, its verdict, its round, its edges, its relay items. There is no second copy to keep in step, and no record in the ledger that some document does not say. So: **never register anything by hand** (no ids invented, no rows typed, no verbs beyond the seal — `references/substrate.md` has the document contract and the rules that refuse a bad document), and **never overwrite a sealed version** (a correction is the next version, and sealing it supersedes the previous one's records automatically).

**Live and superseded.** Every derived record is live until something retires it: a new sealed version of its document, or an explicit `mp supersede` — on the principal's word, or on a later run that disproved it. **Rules read live records only**; superseded records stay in the journal (history is never rewritten) and stop binding anything. Whatever depended on one appears in **`mp worklist`** — a to-do for the PM to judge, never an error and never an automatic re-issue. A sealed document that honestly cited the version governing its own round stays honest.

**Runs are shared facts.** Whoever executes a verification records it once (`mp run record --cmd … --log … [--tree …]`) and gets a `run:<id>`; every other seat cites the id. The run binds to the **tree it judged** — `--tree` in a worktree — so a citation means "this command, over these bytes, gave this output". Re-run only to dispute, and record the disputing run.

## Two channels out of a document

| Channel | Subject | Where it goes |
|---|---|---|
| **Flags** — Out-of-frame risk, Noticed but not fixed | the **product**, or the principal's intent | derived at seal into the flag ledger; the PM dispositions each by id in the Integration Note (invariant 11) |
| **Engine relay** — `## Engine relay`, bullets prefixed `defect:` / `inefficiency:` / `suggestion:` | the **pipeline itself** — the engine, this ledger, `mp` | derived at seal; read with `mp relay list`, sent upstream with `mp relay export` |

A flag about another document's bookkeeping is a relay item, not a flag. Keeping the two apart is what keeps the flag ledger about the work the principal asked for.

## What may be cited

**Summaries are never citable roots.** A claim living in a GroupReport, Integration Note, or any other summary is cited via the underlying artifact the summary carries — the generalization of "flags travel verbatim" (flag decay was summaries being used as sources). Citations are typed **R / F / D / X**, one anchor per criteria row, and D-only agreement is worth zero (invariant 13) — the evidence law lives in `references/substrate.md`, and the seal refuses the violations.

## The anchoring rule — critical

**All ledger paths anchor to the MAIN project root.** The PM resolves the ledger to an absolute path once and embeds that absolute path in every handoff. An agent running inside a git worktree must **never** write to its own worktree's `.claude/` — worktree copies of `.claude/` are untracked, invisible to everyone else, and deleted with the worktree. Writing there loses the artifact. `mp` enforces this mechanically: it resolves the main project root itself and refuses to write under a worktree's `.claude/`.

Corollary: because the default ledger is untracked by git, it is branch-independent — every agent sees the same trail regardless of branch, and reports never merge-conflict. The tradeoff: no git history; the audit trail is carried by versioned filenames (`v01`, `v02`, …). A project that wants tracked paperwork relocates the ledger via PROJECT.md.

## Naming

- **Mission:** `Week<NN>-<MissionName>` — the start week *per PROJECT.md's week scheme* + a descriptive name in PascalCase — or plain `<MissionName>` if the project opted out of week numbers. **Never invent a week number:** the scheme is settled once, at setup (scout the project's timeline; brand-new project → `Week01`; unclear → ask the principal — see `references/setup.md` §9). **No numeric ID.** Two missions may share a week; never a name — `mp mission claim` is what enforces it.
- **Task ID:** `T1…Tn`, scoped to the mission. A task's global identity is `<MissionName> / T<n>`. Filenames never repeat the mission — the folder carries it.
- **Artifact files:** `<Prefix><Category>_<Key>_<YYYY-MM-DD>_v<NN>.md`
  - `<Prefix>` — PROJECT.md's naming prefix; empty by default.
  - `<Category>` — `Charter` · `DesignDoc` · `ArchPlan` · `TaskSpec` · `DevReport` · `Critique` · `GroupReport` · `IntegrationNote` · `CalibrationVerdict` · `ClosureAudit` · `ResearchRequest` · `ResearchResult` · `ResearchTrail`.
  - `<Key>` — the header's `key` field: `T<n>` for task-level files (optionally `T<n>-ShortName` on the TaskSpec); `W<n>` for an aggregate CalibrationVerdict; the mission name for the Charter, ArchPlan, IntegrationNote and ClosureAudit; a topic for DesignDoc and research files.
  - Versions bump per round (DevReport/Critique), per wave (IntegrationNote), or per re-issue; never overwrite a version.
  - **The Charter is re-issued, never edited.** Every version is its own file — `Charter_<Mission>_<date>_v02.md` beside `…_v01.md` — and the new version's amendment ledger carries the principal's verbatim words for every version from v02 on.
- No spaces; underscores between parts, hyphens within a part.

## The registry

`MISSIONS.md` is claimed **before** any fan-out: `mp mission claim` is atomic and derives the registry line (name · branch · started · status). It is what prevents two concurrent missions from colliding on a name — and the first place to look when investigating history. `mp gate close`, run on the principal's sign-off, updates the line.

## Who writes what

| Artifact | Author | Folder | When |
|---|---|---|---|
| MISSIONS.md line | PM | ledger root | derived at `mp mission claim`; updated when `mp gate close` closes the mission |
| Charter | PM drafts / principal signs | mission root | drafted at alignment; sealed before decomposition; a new file per amendment |
| DesignDoc | PM | `design/` | after alignment |
| ArchPlan v01/v02 | Architect | `architect/` | Pass 1 / Pass 2 |
| TaskSpec | PM | `tasks/` | before fan-out, into an open wave |
| Seam contract | the task the Architect names (or the PM) | `tasks/` | frozen before a seam-sharing wave forks |
| DevReport | Constructor | `constructor/` | each round |
| Critique | Crititor | `critic/` | each round |
| GroupReport | Stabilizer | `stabilizer/` | group close or escalation |
| IntegrationNote | PM | mission root | per wave — sealing it closes the wave; final version at close |
| CalibrationVerdict | Calibrator (calibrator-only) / Arbiter (full cell) | mission root | per wave boundary (aggregate) / triggered task cell |
| ClosureAudit | Auditor | mission root | before sign-off (if enabled) |
| CONTRACTS.md entry | ratified at Charter seal (prohibitions) / PM drafts, principal ratifies (the rest) | ledger root | at seal / at sign-off |
| Research trio | PM (request) / Researcher (result, trail) | `research/` | detour only |
