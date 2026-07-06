# The Ledger — where every artifact lives

The ledger is the pipeline's paper trail: operational state, deliberately **outside** the host project's source tree and outside the skill folder. Read this before writing any artifact.

## Locations — two, strictly separated

```
<project>/.claude/skills/mission-pipeline/   ← THE SKILL: engine, read-only, what gets copied between projects
<project>/.claude/mission-pipeline/          ← RUNTIME STATE: this project's bindings + paper trail, never copied
├── PROJECT.md                               ←   the binding layer (from templates/PROJECT.md at setup)
└── ledger/
    ├── MISSIONS.md                          ←   registry: one line per mission (from templates/missions-registry.md)
    └── Week<NN>-<MissionName>/              ←   one folder per mission
        ├── design/        # DesignDoc — what was decided and why
        ├── architect/     # ArchPlan — map + DAG (large missions)
        ├── tasks/         # TaskSpec — one per task
        ├── constructor/   # DevReport — one per task per round
        ├── critic/        # Critique — one per task per round
        ├── stabilizer/    # GroupReport — one per task
        └── research/      # ResearchRequest / ResearchResult / ResearchTrail (only if the detour ran)
```

State lives outside the skill folder so that copying the skill to another project can never drag mission history along. PROJECT.md may relocate the ledger (e.g. into a tracked `docs/` tree) — the layout below it stays identical.

## The anchoring rule — critical

**All ledger paths anchor to the MAIN project root.** The PM resolves the ledger to an absolute path once and embeds that absolute path in every handoff. An agent running inside a git worktree must **never** write to its own worktree's `.claude/` — worktree copies of `.claude/` are untracked, invisible to everyone else, and deleted with the worktree. Writing there loses the artifact.

Corollary: because the default ledger is untracked by git, it is branch-independent — every agent sees the same trail regardless of branch, and reports never merge-conflict. The tradeoff: no git history; the audit trail is carried by versioned filenames (`v01`, `v02`, …). A project that wants tracked paperwork relocates the ledger via PROJECT.md.

## Naming

- **Mission:** `Week<NN>-<MissionName>` — the start week *per PROJECT.md's week scheme* + a descriptive name in PascalCase — or plain `<MissionName>` if the project opted out of week numbers. **Never invent a week number:** the scheme is settled once, at setup (scout the project's timeline; brand-new project → `Week01`; unclear → ask the principal — see `references/setup.md` §9). **No numeric ID.** Two missions may share a week; never a name — check `MISSIONS.md` before claiming.
- **Task ID:** `T1…Tn`, scoped to the mission. A task's global identity is `<MissionName> / T<n>`. Filenames never repeat the mission — the folder carries it.
- **Artifact files:** `<Prefix><Category>_<Key>_<YYYY-MM-DD>_v<NN>.md`
  - `<Prefix>` — PROJECT.md's naming prefix; empty by default.
  - `<Category>` — `DesignDoc` · `ArchPlan` · `TaskSpec` · `DevReport` · `Critique` · `GroupReport` · `ResearchRequest` · `ResearchResult` · `ResearchTrail`.
  - `<Key>` — `T<n>` for task-level files (optionally `T<n>-ShortName` on the TaskSpec); the mission name for the ArchPlan; a topic for DesignDoc and research files.
  - Versions bump per round (DevReport/Critique) or per re-issue; never overwrite a version.
- No spaces; underscores between parts, hyphens within a part.

## The registry

`MISSIONS.md` is claimed **before** any fan-out: add the mission's line (name · branch · started · status) when the mission folder is created. It is what prevents two concurrent missions from colliding on a name — and the first place to look when investigating history. Update status on close (principal sign-off) with the date.

## Who writes what

| Artifact | Author | Folder | When |
|---|---|---|---|
| MISSIONS.md line | PM | ledger root | at claim; updated at close |
| DesignDoc | PM | `design/` | after alignment |
| ArchPlan v01/v02 | Architect | `architect/` | Pass 1 / Pass 2 |
| TaskSpec | PM | `tasks/` | before fan-out |
| DevReport | Constructor | `constructor/` | each round |
| Critique | Crititor | `critic/` | each round |
| GroupReport | Stabilizer | `stabilizer/` | group close or escalation |
| Research trio | PM (request) / Researcher (result, trail) | `research/` | detour only |
