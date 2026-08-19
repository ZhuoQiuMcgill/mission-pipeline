# Changelog

All notable changes to mission-pipeline are documented here. The plugin version,
this file, and the git tag move together — nothing reaches installed users
without a release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

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
