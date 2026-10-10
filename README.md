# Mission Pipeline

Mission Pipeline runs a software project as a traceable pipeline. You talk to one PM, the Claude Code session on your screen. Separate, sandboxed seats plan, build and review the work, and every step is recorded in a ledger. Version 4.0 is a new engine written in TypeScript, in [`engine/`](engine/).

## Key ideas

- **One PM, on your screen.** You talk only to the PM. It restates what you want, records each requirement with its source in your words, and writes the plan. It never builds or judges the product. A prompt hook books every message you send in the ledger. Only important design decisions come back to you: changes to what you get, choices that are hard to undo, and conflicts with what you said.
- **Seats do the work.** Each seat is a separate Claude Code process that has only the program's typed tools. It runs in a bubblewrap sandbox with no network by default. Calibrators check the plan against your words, an Architect breaks it into tasks, Constructors build them and Reviewers accept them. Explorations, escalations and audits each have their own seats.
- **One writer, one judge.** A single ledger service is the only process that writes the ledger. A separate evaluator works out what is proven and what has gone stale. Reads never rescan the whole ledger.
- **Stops take effect at once.** When you say stop, forbid or withdraw, the hook writes the stop to two pre-allocated inboxes. Running units get the signal within 2 seconds, even while the ledger is down. If exactly one mission is involved, the stop covers that mission; if that is unclear, it covers everything. A stop made in error can be narrowed or released.
- **The program delivers.** "Deliver" builds the candidate, checks the proofs, creates a delivery ref and lands it on your target branch in a controlled git view. Your worktrees are never reset or force-checked-out.
- **Exceptions don't block everything.** An exception stops only the action it affects. You get a notice that names a work instruction (WI) with its options.

## Quick start

You need Linux or WSL2, Node 22.12 or later, git 2.44 or later, a systemd user instance, cgroup v2, bubblewrap, and a Claude Code subscription login. The install checks all of these. The full list is in [engine/README.md](engine/README.md#requirements).

```sh
git clone https://github.com/ZhuoQiuMcgill/mission-pipeline.git
cd mission-pipeline/engine
npm ci
node --experimental-strip-types --disable-warning=ExperimentalWarning src/cli/main.ts install --project /path/to/your/repo
```

The last command is `mp install`. It links `mp` into `~/.local/bin`, so later commands are just `mp ...`. Keep the clone where it is, because the engine runs from it.

Then, in Claude Code:

```text
/plugin marketplace add ZhuoQiuMcgill/mission-pipeline
/plugin install mission-pipeline@mission-pipeline
```

Open Claude Code in your project directory. That session is the PM: the engine starts, and the PM's handbook is loaded into its context. Tell it what you want.

## Documentation

- [engine/README.md](engine/README.md): requirements, install flags, daily use, layout and known limitations.
- [`docs/design/DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md`](docs/design/DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md): the design contract (in Chinese).
- [CHANGELOG.md](CHANGELOG.md).

## Earlier versions

3.x is at tag [v3.0.0](https://github.com/ZhuoQiuMcgill/mission-pipeline/tree/v3.0.0). 4.0 does not read 3.x ledgers.

[MIT](LICENSE) © 2026 Zhuo Qiu
