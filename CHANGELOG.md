# Changelog

All notable changes to mission-pipeline are documented here. The plugin version,
this file, and the git tag move together — nothing reaches installed users
without a release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

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
