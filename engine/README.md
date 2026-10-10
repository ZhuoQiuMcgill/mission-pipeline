# Mission Pipeline 4 engine

Version 4.0.0. TypeScript implementation of the design contract [`docs/design/DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md`](../docs/design/DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md) (Chinese; section numbers below refer to it). When code and design disagree, the code is wrong or the design is revised first. Findings deferred past the release are tracked in [`docs/design/Backlog_4.0_PostRelease.md`](../docs/design/Backlog_4.0_PostRelease.md).

## What 4.0 is

You talk to one PM: the Claude Code session on your screen. The PM aligns with you, records requirement items with their source in your words, and writes the PM plan. It never writes or judges the product. Only important design decisions come back to you: changes to what you get, choices that are hard to undo, and conflicts with what you said. Every message you send is booked in the ledger by a prompt hook.

The work is done by seats, each a separate Claude Code process with only the program's typed tools, in a bubblewrap sandbox with no network by default. Calibrators check the plan against your words, an Architect decomposes it, Constructors build, Reviewers accept, Researchers and Crititors run explorations, a one-shot Secretary decides escalations within your authorizations, and an Auditor legalizes a lineage when you ask.

A single ledger service is the only writer of the ledger. A separate evaluator process computes the derived state (what is proven, what is stale) from the base records. A scheduler dispatches seats, and a watchdog keeps the ledger service and the scheduler running. The engine starts when you open the PM session, not at boot.

A stop takes effect at once. When you say stop, forbid or withdraw (停, 不许, 撤回, stop, don't, ...), the hook writes the stop to two pre-allocated inboxes and sends a fast signal to running units within 2 seconds, without waiting for the ledger. The scope is conservative. If exactly one mission is related, the stop covers that mission. That mission is either the one your words name, or the only one that is open or has work queued or running. If the related mission is unclear, or the ledger doesn't answer in time, the stop covers everything. A stop in error can be narrowed or released.

When you say "deliver" (交付), that is also consent to land. The program builds the candidate, checks the proofs, creates a delivery ref under `refs/mission-pipeline/`, and lands it onto the target branch in a controlled git view (repository hooks off, a fixed configuration, nothing deleted). The program never resets or force-checks-out your files.

Exceptions never block the whole flow. Each one stops only the action it affects and arrives as a notice that names a work instruction (WI-01 to WI-27): the trigger, the default action already taken, and the options with their `mp` commands. The PM reads only the WI index and opens a WI page when a notice names it.

## Requirements

`mp install` checks the items marked *checked*. It refuses before writing anything when Node, git, the systemd user instance, the ledger location or the socket path lengths do not fit.

- Linux or WSL2. macOS and native Windows do not run seats in 4.0.
- Node 22.12 or later (*checked*), and the engine's npm dependencies (*checked*; install runs `npm ci` when they are missing).
- A systemd user instance (*checked*: `systemctl --user show-environment` answers and `systemd-run` exists; units run as transient user services). On WSL: `systemd=true` under `[boot]` in `/etc/wsl.conf`, then `wsl --shutdown`.
- cgroup v2 delegating at least `memory` and `pids` to the user (*checked* through the delegated controllers of `user@<uid>.service`). Without delegation, "run command" and verification runs need the `resource-limits` degradation, which you must accept explicitly.
- bubblewrap working with unprivileged user namespaces (*checked*).
- git 2.44 or later (*checked*: the system git in `/usr/bin` or `/bin`, which landing runs; `--attr-source` needs 2.40 and `GIT_NO_LAZY_FETCH` 2.44).
- A Claude Code subscription login, `~/.claude/.credentials.json` (*checked*). Without it no seat can start.
- The ledger on a Linux filesystem, not under `/mnt` on WSL (*checked*), and the control plane on a memory filesystem (*checked*; `$XDG_RUNTIME_DIR` when it is tmpfs, else `/dev/shm`).
- For the stop guarantee (a persisted stop survives a full disk): the inbox files on ext4, xfs, or NTFS that is not compressed or deduplicated. Copy-on-write filesystems (btrfs, ZFS), snapshotted volumes and compressed files do not give the guarantee; install records each inbox's filesystem check.
- A second volume for the backup stop inbox (*checked*). On WSL install picks a Windows volume other than the one holding the virtual disk. Without one, every abnormal stop of the machine with work pending asks you one question (WI-12).
- Optional: fuse2fs, only for tasks that declare a very large writable area.
- Unix socket paths at most 107 bytes (*checked*): keep `--root` short.

## Install

```sh
git clone https://github.com/ZhuoQiuMcgill/mission-pipeline.git
cd mission-pipeline/engine
npm ci
node --experimental-strip-types --disable-warning=ExperimentalWarning src/cli/main.ts install --project /path/to/your/repo
```

Keep the clone where it is: the installed configuration points at it (`engineRoot`), and the plugin runs the engine from there. Install links `mp` into `~/.local/bin`, so later commands are just `mp ...`.

Install also freezes a copy of your Node and Python toolchain for the sandboxes. Seats and their commands never run your live toolchain directories. A toolchain outside the system directories (a Node tarball, nvm, fnm or volta; a pyenv version or a venv) is copied read-only under `<root>/environments/`. The copy is mounted inside every sandbox at the toolchain's original path. Tools in `/usr` and `/bin` are used as they are. A tree over 2 GiB is not frozen, and install reports what it froze and what it skipped. **After you upgrade Node (or Python), run `mp install` again with the same flags**; until then the sandboxes keep the old copy.

`mp install` flags:

| Flag | Default | Meaning |
|---|---|---|
| `--project <repo>` | the git top level of the current directory | the repository the flows work on; the hooks act only inside a registered project |
| `--target-branch <branch>` | `main` | the branch deliveries land on |
| `--credentials subscription\|none` | `subscription` when the Claude Code login exists | the seats' login; `api-key:<VAR>` is refused in 4.0 |
| `--model <id\|alias>` | `claude-opus-5-5` | puts every seat on this model (see [Models](#models)); on a reinstall it rewrites every seat's model in the existing `model_config.json` |
| `--effort low\|medium\|high\|xhigh\|max` | `high` | with `--model`: every seat's effort |
| `--backup-inbox <file>` / `--no-backup-inbox` | chosen on another volume | where the backup stop inbox goes |
| `--root <dir>` | `~/.local/share/mission-pipeline/engine4` | the engine's data: ledger, state, logs, sockets |
| `--control-plane <dir>` | `$XDG_RUNTIME_DIR/mission-pipeline-engine4` or `/dev/shm/...` | must be a memory filesystem |
| `--accept-degradation <name,...>` | none | `resource-limits`, `isolation` or `host-write-cap`, only with your explicit consent |
| `--bin-dir <dir>` | `~/.local/bin` | where the `mp` link goes |
| `--dry-run` | | report the checks and the files it would write; write nothing |
| `--skip-selfcheck`, `--no-start` | | skip the startup self-check, or do not start the engine now |

The configuration goes to `$XDG_CONFIG_HOME/mission-pipeline/engine4.json` (or `~/.config/...`), or to `--config <file>` / `$MP_CONFIG`. Install prints one paragraph to relay: what passed, what needs attention, and the degradations that need your decision.

Then add the plugin in Claude Code and open the PM session in your project:

```text
/plugin marketplace add ZhuoQiuMcgill/mission-pipeline
/plugin install mission-pipeline@mission-pipeline
```

Open Claude Code in the project directory. The session-start hook starts the engine if it is not running and puts layer 0, any pending notices, the PM's core handbook (`plugin/pm/PM.md`) and the WI index (`plugin/pm/wi/INDEX.md`) into the PM's context. The PM then starts its background watcher, `mp watch-notices --stream`, through the Monitor tool.

## Models

Every seat runs on any Claude model your Claude Code login can use. Codex or an OpenAI account is not needed. By default every seat runs `claude-opus-5-5` at effort `high`. Choose another model at install with `mp install --model <id|alias> [--effort <level>]`, or change it later with `mp model-config set <seat>|all --model <id|alias> [--effort <level>]` (the seats are `calibrator`, `architect`, `secretary`, `constructor`, `reviewer`, `researcher`, `crititor` and `auditor`; `all` sets every seat). Seats started after the change use it. `mp model-config show` lists them; the file is `config/model_config.json` under the `--root` directory.

A model is a Claude model id (`claude-sonnet-4-5`), a dated snapshot (`claude-haiku-4-5-20251001`), or an alias Claude Code accepts: `opus`, `sonnet`, `haiku`, `fable` (also with `[1m]`). The metering proxy prices each request from its price table (the built-in prices, plus any that `model_config.json` adds under `metering.prices`). A model the table does not list, such as a newer one, is priced at the highest price of its family, so the accounting over-counts rather than under-counts. A model that is not a Claude model is refused.

Claude Code either redirects a retired model to the current model of its family, or refuses it. A seat's outcome records the models that actually served it, and `mp show task` prints "configured X, served Y" when they differ. When Claude Code refuses a seat's model, the attempt ends as an environment failure and the PM gets a WI-09 notice to switch that seat (or all seats) to a model the login can use.

## Daily use

- Talk to the PM. It opens a mission (`mp mission open <mission>`), restates your requirements, records them (`mp requirement add`, `mp plan submit`), and asks only what 3.2 says it must.
- Mission ids use letters, digits and `-`, start with a letter or digit, and are at most 64 characters. No `.`, `_` or spaces: derived ids join their parts with `.`, so `mp mission open` refuses anything else. Requirement item and constraint ids follow the same rule.
- Project constraints (`mp constraint add <mission> <constraint> --kind object|instruction --text "..." [--paths ...] [--task-types ...]`) apply to the whole project, not only to the mission they were recorded from. Each one reaches the cards whose paths and task types it covers. A new text recorded from any mission applies everywhere, and the results it covered need a new review. Widening a scope leaves a gap only for paths not yet reviewed against it, and narrowing a scope leaves none.
- Say 停 or stop at any time. The PM tells you the stop's state: persisted (awaiting commit), committed, stopped. `mp stop-narrow` and `mp stop-release` undo a stop in error after you confirm.
- Seats start only after the startup self-check has passed for the installed Claude Code, SDK and Node versions. `mp install` runs it (offline items, then a few live requests under the seat login on the cheapest model). When a version changes, the engine reruns it in the background when the PM opens, at most once an hour per version; a failure arrives as a WI-18 notice, and `mp selfcheck` retries by hand.
- Ask how it is going. The PM reads `mp status` (layer 0: stops, the recovery pause, the evaluator, blocks, spend, landings, notices by WI) and `mp show mission|task|requirement|object|delivery|stop|alert <id>` for detail.
- Notices arrive through the watcher, the session-start hook, or with your next message. `mp alerts` lists them with their WI page; `mp alerts --ack <id>` marks one handled.
- Say "deliver": `mp deliver <mission> --outputs <object,...>` creates the delivery ref and lands it. `mp land <delivery>` starts a new landing attempt; `mp land <delivery> --deliver-ref-only` leaves the merge to you; `mp withdraw-delivery` records that you withdrew it.
- Close a mission: `mp close <mission> --mode with-risk|full|post-audit`.
- After a reboot the engine may pause (WI-12). The PM asks whether you sent a stop it may have missed, then runs `mp resume --answer "<your answer>"`.

Every state-changing command takes `--op <id>` (or generates one) and records the PM's action in the ledger; repeating a command with the same id does not run it twice. `mp help` lists all commands; `--json` gives machine output.

## Layout

| Directory | Owns | Design |
|---|---|---|
| `src/common/` | ids, hashing, durable file writes, base record types, socket path checks | 5, 6.1, 9.1 |
| `src/ledger/` | the ledger service (single writer), stop inboxes and probes, control plane, intents, launches, startup decision, PM action and notice records | 6.1, 6.3, 6.4 |
| `src/evaluator/` | the derived-state evaluator: `semantics.ts` (the proof model as a least fixed point; `fullCompute` is the oracle), `incremental.ts`, `snapshot.ts`, `evaluator.ts`, checkpoints | 5, 6.1 |
| `src/flow/` | the decision-layer, execution, exploration and legalization flows | 3, 4, 8, 11 |
| `src/delivery/` | delivery manifest, candidate, proof check, delivery ref | 6.6 |
| `src/git/` | safe git wrapper, program refs, landing in the controlled config view, representation (eol, ident, LFS pointers), landing admission | 6.6, 7.1 |
| `src/exec/` | execution units: delegated cgroups, unit supervisor and termination proofs, bubblewrap tool sandbox, program tools | 6.2, 6.5, 7.1 |
| `src/seat/` | seat host on the Agent SDK with typed tools only, metering proxy, self-check | 6.5, 7.1, 9.3 |
| `src/scheduler/` | dispatch, takeover, proof reconciliation, watchdog, the flows' scheduler RPC | 6.2, 6.3 |
| `src/cli/` | `mp` and the PM session's hooks | 9.2, 3.9 |
| `plugin/` | the Claude Code plugin: hooks, `bin/mp`, the PM handbook and WI pages | 3.9, 3.11 |
| `test/` | `node:test` suites; `v14-NN-*.test.ts` are the §14 verify-first scenarios | 14 |

## Development conventions

- Node 22.12 or later; code runs with `--experimental-strip-types`, so only erasable TypeScript syntax: no `enum`, no `namespace`, no parameter properties. Imports use the `.ts` extension.
- `npm run typecheck` (tsc, strict) and `npm test` (node:test) must both pass. `npm run test:perf` runs the 5.5 performance gates (ledgers of 100,000+ records).
- The end-to-end suite `test/e2e-mission.test.ts` runs missions through real units and takes about 10 minutes; it is skipped unless `MP_E2E=1` is set.
- Run tests with a short `TMPDIR` on a Linux filesystem (for example `TMPDIR=$(mktemp -d /tmp/mpc.XXXX)`): socket paths must fit in 107 bytes, and the fixtures refuse longer ones.
- Ids, paths and hashes are branded types (`src/common/ids.ts`); never infer a type from a string's shape.
- SQLite databases and anything that needs reliable locks or fsync live on a Linux filesystem (tests use `os.tmpdir()`), never under `/mnt` (6.1).
- Every git invocation goes through the safe wrapper in `src/git/` (hooks off, fsmonitor off, no content filters except the allow list).
- No test may touch the real exported ledgers under the repository's `data/` directory.
- Product documents (the PM handbook, WI pages, README, CLI text) are in English; the design documents are in Chinese.

## Known limitations of 4.0

- Seats use the Claude Code subscription login only; API-key seats come later.
- Money spend limits are not available yet (`mp spend-limit <mission> unlimited` works; an amount needs a scheduler method that is not there).
- reftable repositories get no deliveries: run `git refs migrate --ref-format=files` first.
- Shallow and partial clones, deliveries that change submodules (gitlinks), and attribute-only changes are not landed automatically; the PM gives you the merge commands.
- 4.0 does not read 3.x ledgers.
- pyenv shims are not followed when the toolchain is frozen. Put the pyenv version's `bin` (or a venv) first on `PATH` when you run `mp install`.
- A continuation review is always done as a full review (correct, one extra review), and re-acceptance after a basis change in stable mode is not implemented (such results stay "not fully proven").
- Product and candidate commits have no protecting ref yet; `git gc` may reclaim them after about two weeks (the results stay in the content store and can be rebuilt).
