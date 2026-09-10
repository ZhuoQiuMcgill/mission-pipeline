# Ledger — schema 4

Project bindings live in `.claude/mission-pipeline/PROJECT.md`; runtime state defaults to `.claude/mission-pipeline/ledger/` unless an explicit mp.json ledger binding names another path. The installed skill remains separate.

- `.writer-owner/owner.json` identifies the sole writer environment, epoch and readiness.
- `runtime-manifest.json` and its recovery copy identify immutable legacy source and checksummed journal segments.
- `segments/*.jsonl` contain versioned atomic event envelopes. An incomplete tail is preserved with a segment boundary; a corrupt complete event is never skipped.
- `blobs/` stores original document, input, log and delivered-artifact bytes by SHA-256.
- `effect-receipts/` binds completed product installations to durable event checksums. No product file changes before its event is durable; recovery completes the same conditional installation or preserves a conflicting intervening edit.
- `mp.db` is a disposable SQLite projection; `doctor` compares it with authoritative replay and `rebuild` restores it.
- `views/runtime.json` is a derived fenced publication. It is never an authority source.
- `legacy/` retains migration sources and before-v4 recovery evidence; retired-v4 history is preserved after an allowed rollback.

Role prose belongs in immutable source documents referenced by the structured request or submitted through seal. Do not hand-edit SQLite, manifests, event files or generated views. A valid source/reference receipt establishes completion; an attempted operation or copied log pathname does not.

See [runtime-v4](runtime-v4.md) for current qualification and [setup](setup.md) for writer handoff, migration and recovery. Original production evidence should be analyzed through isolated fixtures or declared read-only plans, never overwritten to make an old hash match.
