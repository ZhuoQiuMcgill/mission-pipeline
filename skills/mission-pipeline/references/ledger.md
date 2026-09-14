# Ledger — schema 4

Project bindings live in `.claude/mission-pipeline/PROJECT.md`; runtime state defaults to `.claude/mission-pipeline/ledger/` unless an explicit mp.json ledger binding names another path. The installed skill remains separate.

## What is in the ledger directory

- `.writer-owner/owner.json` identifies the sole writer environment, its epoch and readiness.
- `runtime-manifest.json` and its recovery copy identify immutable legacy source and checksummed journal segments.
- `segments/*.jsonl` contain versioned atomic event envelopes. An incomplete tail is preserved with a segment boundary; a corrupt complete event is never skipped.
- `blobs/` stores original document, input, log and delivered-artifact bytes by SHA-256.
- `effect-receipts/` binds completed product installations to durable event checksums. No product file changes before its event is durable; recovery completes the same conditional installation or preserves a conflicting intervening edit.
- `mp.db` is a disposable SQLite projection; `doctor` compares it with authoritative replay and `rebuild` restores it.
- `views/runtime.json` is a derived fenced publication. It is never an authority source.
- `legacy/` retains migration sources and before-v4 recovery evidence; retired-v4 history is preserved after an allowed rollback.

## What is not in the ledger directory

The writer identity token lives outside it, in `<config dir>/mission-pipeline/writer-id`: `$XDG_CONFIG_HOME` or `~/.config` on POSIX, `%APPDATA%` on Windows. It is created with random hex on first use, and the writer identity is `sha256(platform family, token)[:24]`. Archive it with the ledger. If it is lost, the principal reclaims the ledger with `maintenance takeover --confirm <project id>`, which increments the epoch and records `takeover_from`.

Bridge registrations also live outside the ledger, by default in `.claude/mission-pipeline/bridge-mappings`. Re-register them after upgrading the installed skill, before the first cross-platform request.

## Discipline

Role prose belongs in immutable source documents referenced by the structured request or submitted through seal. Do not hand-edit SQLite, manifests, event files or generated views. A valid source or reference receipt establishes completion; an attempted operation or a copied log pathname does not.

Reads are cheap and safe: `query <kind> <id>`, `status`, `render`. Writes go through the typed request surface only.

`recover()` verifies the journal tail past a stored watermark rather than replaying everything on each write. The full replay comparison lives in `doctor` and `rebuild`, which is where you run it when something looks wrong.

See [runtime-v4](runtime-v4.md) for current qualification, [walkthrough](walkthrough.md) for a worked mission and [setup](setup.md) for writer handoff, migration and recovery. Original production evidence should be analyzed through isolated fixtures or declared read-only plans, never overwritten to make an old hash match.
