# Changelog

All notable changes to mission-pipeline are documented here. The plugin version,
this file, and the git tag move together — nothing reaches installed users
without a release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [1.0.0] — 2026-08-31

The anti-drift, anti-circular-corroboration release — and the largest change in the
project's history: the engine's species changes from pure prose to prose + a
deterministic substrate. Evidence-mined from the same seven-mission production ledger
as 0.3.0 (433 artifacts, Week 21–27), whose drift had two structural causes: nothing
checks the checker — the PM, the longest-lived context and the primary drift source,
was unaudited mid-mission — and circular corroboration: N documents with one common
ancestor are 1 root + N−1 echoes, but every reader counts documents, not roots. This
release freezes the goal before the mission's document web exists, arms five defense
layers against drift, types every citation by its evidential root, and gives the
invariants an enforcement layer. Rationale record:
`docs/design/DesignDoc_CalibrationAndSubstrate_2026-08-31_v03.md`.

### Added
- **The Charter** (`templates/charter.md`): a frozen per-mission calibration basis,
  sealed before decomposition — the principal's verbatim words plus confirmed
  read-backs (on conflict, the verbatim words govern). Prohibitions are ratified into
  `CONTRACTS.md` in the signing act, zero extra principal interaction, and bind every
  task from wave 1. Only the principal amends it, via the conversational chain,
  recorded verbatim; every amendment marks specs citing the prior version stale. No
  sealed Charter, no fan-out — a one-line fix mission has a one-paragraph Charter.
- **Five defense layers against drift**, each sitting where its question is
  well-posed and cheap: standing-contract prohibitions checked on every task (L1 —
  free, the Crititor already reads the registry); Architect Pass 2 Charter-lint
  before fan-out (L2); a risk-triggered task-level calibration cell (L3 — recovery
  tasks, post-amendment specs, round-3 passes, post-compaction specs); the PM
  re-grounding ritual at every wave boundary (L4 — the only preventive layer, aimed
  at compaction); the aggregate calibration cell at every wave boundary (L5, the
  main force — the actual production escapes were aggregate trends no per-step
  check could see: verification narrowed 100% → 0% across six missions in
  individually legal steps).
- **Calibration cells and two new roles** (`roles/calibrator.md`,
  `roles/challenger.md`; arbiter as a Stabilizer variant;
  `templates/calibration-verdict.md`, one per wave). The Calibrator is deliberately
  starved — sealed Charter, the wave's delivery set, mechanical cross-wave metrics,
  and none of the document web's frame; the Challenger is deliberately fed and must
  discharge each accusation with written authorization or concede — a Charter line,
  a ratified amendment, a recorded principal disposition; derived documents are not
  tender. Two legal accusation shapes: trend (must cite metrics) and contradiction
  (must quote the Charter). Verdicts: ALIGNED launches the next wave; SUSPICION
  forces a PM disposition, and recurrence in consecutive waves auto-escalates — the
  ratchet the PM cannot absorb; DRIFT halts the affected fan-out only, and reaches
  the principal in goal language, never as machinery. Cell inputs are computed by
  rule from the ledger — the PM spawns the cell but cannot curate what it reads.
- **Evidence law:** every evidence citation in a verdict-bearing artifact carries a
  type — R (reality: executed output, fingerprint-bound), F (fixed point: frozen
  before the mission web), D (derived: any mission-era document), X (external:
  fetched and verified) — under six rules: D+D agreement = zero weight; every
  criterion marked "met" needs ≥1 R or F anchor; D never upgrades by being cited
  more; R binds to source state and fails closed on mismatch; summaries are never
  citable roots (flag decay was summaries being used as sources); stale citations
  are flagged, with Charter amendments propagating staleness automatically.
- **Invariant 13 — Echoes are not evidence.** "Agreement among derived artifacts
  adds no evidential weight. No acceptance stands without at least one
  reality-anchored or fixed-point anchor, and reality anchors bind to the source
  state that produced them." (Ledger evidence: coherence laundered error — reading
  more of a wrong-but-consistent document web made the error less visible, not
  more.)
- **The deterministic substrate** (`scripts/mp` — one file, Python ≥ 3.8, stdlib
  only, zero dependencies; agent-facing documentation in
  `references/substrate.md`). Three-layer authority: `ledger/events.jsonl` is an
  append-only journal, authoritative for every state transition **including
  refused operations** — the enforcement layer of "silence is not disposal" must
  not itself work silently; `ledger/mp.db` is a derived SQLite view, rebuildable by
  replay (`mp rebuild`), where invariants become constraints — round cap = CHECK,
  registry collision = UNIQUE, undisposed flags refuse close; markdown stays
  authoritative for judgment prose. Single write path, journal first, under a
  lock; `mp doctor` replays the journal against the DB and reports divergence.
  DrvFS/WSL detection built in.
- **Hardened closing gate and source fingerprints:** `mp gate close` refuses while
  any flag is undisposed, lint fails, or the Charter is stale; gate runs bind their
  log and its hash to a source fingerprint (commit SHA + dirty state + tree hash),
  and verification fails closed on fingerprint mismatch. (Ledger evidence: CRLF
  checkout drift changed byte-addressed hash inputs while `git status` read clean —
  semantically coherent documents on mechanically drifted bytes, invisible to every
  seat.)
- **Invariant 12 — The principal converses; agents operate.** "Every principal
  decision must be expressible and deliverable in one plain sentence. Any pipeline
  step that requires the principal to execute an instruction, operate a tool, or
  absorb machinery detail is an engine defect, not a configuration option." The
  principal's command count is zero — `mp` is agent-internal and self-identifies as
  such. Authority without commands: the principal says it in one sentence, the PM
  reads back and executes on their behalf, recording the verbatim words — and at
  sign-off presents the **"acts in your name" repudiation list** (amendments,
  ratifications, dispositions), repudiable item by item, closing the loop that
  would otherwise let a D-type claim ("PM says the principal approved") pose as an
  F-type anchor. Compaction disclosure becomes a mandatory Integration Note line.
- **Machine-readable headers** on the task-spec, dev-report, and critique
  templates, plus the evidence-type column — verdict-bearing artifacts are now
  mechanically lintable (`mp lint`: typing present, D-only chains, staleness).
- **Tests** (`tests/`): the M1 gate — `mp adopt` on the DIVRA export (433
  artifacts, 7 missions, 67 tasks) followed by `mp metrics` mechanically reproduces
  the retrospective once done by hand; the analysis is now a SELECT and stays the
  regression test (`tests/m1_acceptance.py`, plus `tests/m1_smoke.py`). The M2
  gate (`tests/m2_lint.py`): `mp lint` catches seeded violations of each of the six
  evidence rules, and `mp gate close` fails closed on source drift. The M3 gate
  (`tests/m3_dryrun.py`): a dry-run mission exercises the defense layers —
  prohibition catch, Charter-lint catch, triggered task cell, SUSPICION ratchet,
  DRIFT halt — and closes through the hardened gate. 117 checks, zero failures.

### Changed
- **Default executors flipped** (invariant 12): Researcher, Auditor, and the
  calibration seats default to PM-spawned fresh contexts with engine-fixed inputs —
  parallax is bought with fresh contexts, never with principal labor. "Principal
  runs it in a separate session" remains an optional PROJECT.md binding.
- **Setup shrinks and bootstraps the substrate:** the interview becomes one
  consolidated scouted proposal plus a single veto pass — individual questions only
  for what the scout cannot answer, typically the principal's identity and the week
  scheme. `/mission-pipeline:init` now also runs `mp doctor` (environment check)
  and `mp init` (state creation) — executed by the agent, never by the principal.
- **Python ≥ 3.8 (stdlib only) is required for new missions.** `mp doctor` fails
  the install loudly, never a mission midway. v0.3-era prose ledgers remain
  readable and are imported via `mp adopt`.
- **Semver commitment:** from 1.0.0 on, breaking changes to the binding contract
  (PROJECT.md slots), the `mp` command surface, or the schema (beyond `mp migrate`)
  imply a major bump. The DB carries `schema_meta` and migrates forward.

### Notes
- Released ahead of the first dogfooded mission by the principal's decision: the
  mechanical gates are green; the first field deployments are the dogfood, and their
  ledgers return for analysis through the same `mp adopt` + `mp metrics` path.
- `tests/m1_acceptance.py` needs the DIVRA export under `data/`, which is not
  distributed; the other three test files are self-contained.

## [0.3.0] — 2026-08-19

Frame-parallax release. Mined from a seven-mission production ledger (433 artifacts,
Week 21–27): every seat executed its prompt faithfully — zero invariant violations —
yet a fully-accepted mission shipped 13 latent test failures. The escapes lived in the
contracts, not the execution. This release re-arms the contracts.

### Added
- **Invariant 10 — Reality closes the evidence:** no mission reaches sign-off without
  one full-scope verification run (the closing gate) over the integrated result.
  Task-level verification may be narrowed for speed; the closing gate may not.
  (Ledger evidence: full-suite verification narrowed monotonically 100% → 0% across
  six missions, each step contractually legal, before the escape.)
- **Invariant 11 — Flags route; silence is not disposal:** out-of-frame flags and
  noticed-but-not-fixed items reach the PM verbatim and each gets an explicit,
  recorded disposition. (Evidence: a declared evidence-identity drift decayed
  Constructor → "Notes, non-blocking" → "declared and non-blocking" → absent from the
  closure note — every seat compliant, the risk shipped.)
- **Out-of-frame flag channel:** mandated `Out-of-frame risk` section in the critique
  (exactly one item or a justified "None"; never feeds the verdict), mandated
  `Noticed but not fixed` in the dev report, both carried verbatim by the group
  report and dispositioned in the Integration Note. (Evidence: schema-mandated
  sections landed at 86–97%; prose-only instructions landed at 0.8–35%.)
- **Standing-contracts registry** (`ledger/CONTRACTS.md`, `templates/standing-contracts.md`):
  ratified project invariants that bind every task like acceptance criteria, whether
  or not a spec restates them; violations are automatic CHANGES-REQUESTED; PM drafts,
  principal ratifies at sign-off.
- **Auditor** (optional role, `roles/auditor.md` + `templates/closure-audit.md`): one
  arms-length read before sign-off — does the integrated result deliver the design
  decision's stated goal? Runs by default in a separate principal session; a different
  model family is preferred when available, never required (single-model deployments
  get parallax from fresh session + artifacts-only inputs + a different question).
  Report reaches the principal unfiltered; the PM gets a copy, not a veto.
- **Integration Note** as a mandated artifact (`templates/integration-note.md`):
  merges, escalation decisions, the flag ledger with dispositions, footprint
  reconciliation (ArchPlan predictions vs files actually touched), and the closing-gate
  record at mission close.
- **Architect Pass 2 spec lint** (cold read, feeds the delta veto): pointer
  requirements left unexpanded, unanchorable acceptance criteria, verification-scope
  regression vs earlier waves and the closing gate, missing out-of-scope — plus an
  `Unstated assumptions` section. (Evidence: a requirement reading "implement all
  contracts required by DesignDoc §4–5" produced a criteria table with no
  corresponding row; the contract shipped incomplete and cost 5 of the next
  mission's 12 tasks in recovery.)
- **PM protocol:** read-back of frame-level directives (compiled policy, scope and
  boundary, ≤2 lines, confirmed before it enters any document); commitment-delta veto
  surfaced one item at a time, most critical first; explicit disposition duty for
  every flag; standing-contract curation; the closing gate before sign-off.
- **Stabilizer evidence spot-check** before any accept: sample the critique's
  citations — `file:line` exists and says what is claimed, cited tests re-run green.
  Judging paperwork, not re-reviewing; a failed spot-check returns the critique for
  correction in the same round.
- **Crititor inputs widened:** the standing-contracts registry, and every document the
  spec's mandatory reading names — "inputs, not references," the mission's design
  decision included. Purpose-anchored required changes: meeting the letter of the
  criteria while defeating a written purpose is a Required change, not a Note.
  (Evidence: 87% of specs pointed at the design doc; 0 of 98 critiques read it; the
  one critique in the corpus that did produced the deepest finding of two missions.)
- **PROJECT.md slots:** Document map (mission-rationale location — mid-pipeline
  adoptions point it at their existing tree, never restructure; standing-contracts
  location), the closing gate, and Closure-audit bindings. Setup interview §12–13;
  `/mission-pipeline:init` seeds `ledger/CONTRACTS.md`.

### Fixed
- `/mission-pipeline:init` referenced `${CLAUDE_SKILL_DIR}`, which does not exist in
  plugin command context — both references now use `${CLAUDE_PLUGIN_ROOT}`, so the
  command can actually locate `setup.md` and the templates.

## [0.2.0] — 2026-07-07

### Added
- `/mission-pipeline:init` plugin command — idempotent project initialization:
  creates the state folders, briefly scouts an existing project (stack,
  conventions, verification commands, week evidence; read-only, coexists with
  any established workflow), then runs the setup interview pre-filled with the
  scouted answers so the principal vetoes proposals instead of answering open
  questions.
- Setup reference (`references/setup.md`): explicit read-only scout phase as
  install step 3; the interview now asks only what the scout could not answer.

## [0.1.0] — 2026-07-06

Initial public release.

### Added
- The engine: mission lifecycle, bounded build–critique–stabilize group loop
  (default 3 rounds), wave-based parallel execution, escalation ladder, and the
  nine named invariants (`skills/mission-pipeline/SKILL.md`).
- Six role definitions: PM, Architect, Constructor, Crititor, Stabilizer,
  Researcher (`roles/`).
- Engine/binding separation: read-only engine files + a single per-project
  `PROJECT.md` binding layer; upgrades are drop-in, drift is `diff`-detectable.
- Per-mission ledger outside the source tree
  (`.claude/mission-pipeline/ledger/`, relocatable), with the main-root
  path-anchoring rule for worktree safety.
- Setup interview (`references/setup.md`), including the scout-don't-invent
  week-scheme rule: adopt the project's counter, else `Week01` for new
  projects, else ask — never the calendar week.
- Seven artifact templates: PROJECT.md, task-spec, dev-report, critique,
  group-report, arch-plan, missions-registry (`templates/`).

### Notes
- Extracted from a production deployment that ran multi-wave missions with
  10+ parallel task groups; the packaging (plugin + marketplace) is new in
  this release.
