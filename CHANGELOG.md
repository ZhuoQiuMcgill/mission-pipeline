# Changelog

All notable changes to mission-pipeline are documented here. The plugin version,
this file, and the git tag move together — nothing reaches installed users
without a release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- **`mp lint` no longer asks a v1.0.0-sealed document for sections it never had.** The
  `seal-parse` rule re-checks a sealed document against the v1.1 section contract; on a
  migrated ledger every document sealed by the retired `artifact.seal` (a hash, never
  sections) came back as "no longer parses" — 110 findings on one mission, 163 across a
  deployment — and `mp gate close` refuses on any finding, so no mission that began
  before the migration could close mechanically. The rule now binds only documents
  sealed by the v1.1 derivation seal (`artifact.sealed`), read once from the journal;
  a v1.1 document that loses a required section is still caught (`tests/m4_migrate.py`).
- **`mp calib triggers` orders the post-compaction window by artifact id, not by the
  clock.** Seal timestamps have one-second resolution, so a spec sealed in the same
  second as the Integration Note it precedes landed "inside" the note's window and fired
  `post-compaction` — `tests/m3_dryrun.py` failed on main about one run in two. The
  window is now bounded by the closing note's `closed_in` artifact id (the artifact is
  the event), with the timestamp as the fallback for pre-`closed_in` rows.

## [1.1.0] — 2026-09-04

The derivation release. Three days of real use of 1.0.0 (5 missions, 77 tasks, 3296
field journal events, 5.25 MB of ledger prose) measured where the tokens went: **68 % of
all journal events were agents hand-copying facts from documents into the database** —
`evidence add` alone was 1088 calls and 73 % of everything typed into `mp`, and 0 of 8
sampled critiques still agreed with their own evidence rows. Meanwhile the real
invariants fired 0 times, because they were attached to optional ceremony (`round open`
was used on 36 of 76 tasks), the aggregate calibration's trend shape was dead (a metrics
bug dropped 12 of 77 tasks, so the Arbiter rightly refused every trend accusation), and
61 % of flags were about the ledger rather than the product. The defect was
double-entry: truth in two places, with the model as the courier. This release removes
the second entry. Rationale record:
`docs/design/DesignDoc_DerivationAndSupersession_2026-09-04_v01.md`.

### Added
- **`mp seal <path>` — the artifact is the event.** Agents write a document once and
  submit it with one call; the engine parses the `mp:header` block and the document's
  structured sections and derives every record: the artifact, evidence rows (the
  criteria table with its Type column), flags (Out-of-frame risk, Noticed but not
  fixed), verdicts, rounds, edges (`derives-from`), dispositions (an Integration Note's
  flag ledger), relay items, standing contracts (a Charter's prohibitions), wave
  closure. One journal event per artifact carries the full derived payload, so replay
  never re-reads a file. The M3 dry run measures the point: **2.00 journal events per
  artifact** against the field's 10.40, with no declaration verb in the journal.
- **Rules run at seal — the one step nobody can skip.** Refused, by name: a round past
  the cap (invariant 4); a "met" resting only on D/X evidence (invariant 13); an R anchor
  to a run that does not exist; a D anchor to a GroupReport or Integration Note
  (summaries are never roots); a `charter:vN` with no such version; a TaskSpec whose
  wave is not open or whose out-of-scope is empty (invariant 5); a Charter version
  without its amendment row; an Integration Note disposing an unknown flag or leaving a
  disposition empty (invariant 11); an unresolvable `derives-from` or an anchor to an
  unknown id; a missing required section. A refusal names what to change in the
  document; agents fix the document and seal again — never route around it.
- **Runs are shared facts:** `mp run record --cmd … --log … [--tree <worktree>]
  [--scope closing]` records an execution once, identified by (tree hash, command,
  output hash); everyone else cites `run:<id>`. Fingerprints bind the **judged tree**,
  not the mission tip. (Field: 26 % of R evidence duplicated another seat's identical
  run — the same suite executed by up to five seats.)
- **Supersession:** `mp supersede <kind>:<id> --by principal|reality|<kind>:<id>
  --reason …` retires any record — artifact, verdict, flag (reopens its disposition),
  evidence, charter version, contract, run. Sealing a new version supersedes the old
  one automatically. **Rules read live records only.** Whatever depended on a
  superseded record appears in **`mp worklist`** — a to-do for the PM to judge, never
  an error and never an automatic re-issue. (Field: 23 of 23 lint findings were lawful
  citations of superseded documents; the only "repair" was re-issuing unchanged content,
  and one close was blocked for 10 h 44 m.)
- **Waves with teeth:** `mp wave open W<n> --mission … --tasks …` is one call per
  fan-out (single-wave missions included) and is **refused while a DRIFT stands or two
  consecutive SUSPICIONs stand** — the ratchet. Only the principal clears them
  (`mp supersede verdict:<id> --by principal`), recorded verbatim; no project rule or
  standing contract outranks this. (Field: a fired ratchet was absorbed under a project
  contract and fan-out continued — nothing mechanical stood in the way.) TaskSpecs seal
  only into an open wave; the wave's Integration Note closes it.
- **`mp calib triggers`** computes the task-cell triggers from the ledger (recovery
  task, post-amendment spec, cap PASS, post-compaction window × `touches-contract`) —
  the PM no longer checks them by hand.
- **Engine relay:** `## Engine relay` sections and `mp relay add|list|export` — the
  upstream channel for observations whose subject is the pipeline itself, exported as a
  PR-ready body. Adopted from the deployment's own `engine-relay/` practice. Flags stay
  about the product.
- **`mp acts --mission`** derives the "acts in your name" list from the journal for the
  Integration Note and sign-off.
- **Schema v2 and `mp migrate`:** 1.0.0 ledgers upgrade in place; their journals replay
  whole; v1 and v1.1 events coexist (`tests/m4_migrate.py`).
- **Tests:** `tests/m2_lint.py` is now the seal gate (every evidence rule refused at
  the door, by name; stale is a worklist item); `tests/m3_dryrun.py` drives a whole
  mission by documents alone; `tests/m4_migrate.py`; fixture documents under
  `tests/fixtures/` are the reference implementation of the document contract. 168
  checks, five gates.

### Changed
- **Calibration is cheap first:** the Calibrator runs alone; with no anchored accusation
  it writes the wave's ALIGNED verdict itself (`## Convened: calibrator-only`) and the
  cell ends there — Challenger and Arbiter are convened only on cause. (Field: 30 cells,
  ~90 seat runs; the expensive seats had work in a minority of them.) The post-compaction
  trigger is bounded: specs written after a compaction and before the next completed
  re-grounding, and only when the spec's `touches-contract` is yes — the engine-neutral
  form of PR #3.
- **Charter is re-issued, never edited in place:** each amendment is a new Charter file
  at the next version whose amendment-ledger row carries the principal's verbatim words;
  sealing v1 ratifies `## Prohibitions` into standing contracts automatically.
  `mp charter amend` is retired (refused with the re-issue instruction).
- **Flags are derived, not carried:** the Stabilizer no longer copies flags into the
  group report (section removed); the Integration Note's flag ledger carries flag ids.
  The Stabilizer's spot-check narrows to "does the cited evidence say what is claimed" —
  existence is the engine's.
- **Seams and the integration round** (PR #2, verbatim): seams are payload contracts
  frozen before the fork; a seam-sharing wave ends with its own bounded integration
  round whose acceptance is a real-objects end-to-end proof. The Architect's Pass 2 now
  detects seams.
- **`mp gate close` records the principal's sign-off**: the closing run is recorded
  beforehand (`mp run record --scope closing`), the mission is presented, and the call
  is made on acceptance.
- **Metrics:** buckets always sum to the task count (`r_other`); rounds derived from the
  reports' rounds; lint no longer reports staleness (worklist does).
- **Deprecated, still working for replay:** `artifact new|seal`, `edge add`,
  `round open|close`, `verdict record`, `flag add|dispose`, `evidence add`,
  `fingerprint take`, `charter seal`, `gate record`, `contract add`. Not the documented
  path; marked DEPRECATED in `--help`.

### Fixed
- The journal could record an OK event that never applied (a seat passed a journal
  sequence number where an artifact id was required; the row rolled back after the
  line was fsynced, and the next id was allocated three times). The write path now
  applies inside a savepoint **before** journaling — an apply failure is journaled as
  REFUSED — and every action validates its referenced ids. Replay is tolerant of the
  historical lines such journals already carry (from PR #1).
- `mp metrics` silently dropped tasks with 0 or > 3 rounds, which disabled the trend
  half of calibration (2 of 70 field accusations were trend-shaped). From PR #1.
- `mp doctor` reported absolute-path registrations as tampering (30 of 31 field
  FAILs); paths are stored relative to the project root and normalized.
- Heading matching is by leading phrase and HTML comments are stripped before
  parsing, so template guidance never becomes a phantom flag.

### Notes
- The three field PRs are absorbed: #2 verbatim, #1's replay tolerance and metrics
  fix, #3's intent in engine-neutral form; #1's Charter special cases are unnecessary
  under supersession.
- Upgrading a live 1.0.0 project: replace the skill folder, then the PM runs
  `mp migrate` once. The one grammar rule seats will meet: the Evidence cell of a
  criteria row is the anchor (`run:7`); trailing annotation is tolerated, prose belongs
  in the sections.
- Round-2 field data is the next input: events per artifact, refusals that bite,
  cells convened vs calibrator-only, worklist size, relay volume.

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
