# Seat isolation probes (4.0 design, 2026-10-08)

Exploratory probes that reproduce the seat-isolation observations cited in the 4.0 design doc §9.3.
**They are not release gates**: they print results instead of asserting them, and `probe-sdk.mjs` uses an `echo` prefix rule that a compound command such as `echo hi; touch x` bypasses (round-2 critique #8). The gating self-check and its eight assertions are specified in `../DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v03.md` §9.3.
Measured on Claude Code 2.1.295, `@anthropic-ai/claude-agent-sdk` 0.3.295, Node 22.17.1, WSL2.

Each probe creates a throwaway directory containing a `CLAUDE.md` with a marker word, then asks a seat
whether the marker is in its context and tries one allowed and one disallowed shell command.

- `probe-cli.sh` — headless `claude -p`: plain mode vs `--safe-mode --permission-mode dontAsk`.
- `probe-sdk.mjs` — Agent SDK with `settingSources: []`, `tools`, `canUseTool`, with and without
  `strictMcpConfig: true, mcpServers: {}`.
- `probe-typed-tool.mjs` — a seat with no built-in tools and one in-process typed tool (`createSdkMcpServer` + `tool`),
  `strictMcpConfig: true`. Exits 0 only if the tool handler received one PASS call and no account connector appeared.
  Usage: `node probe-typed-tool.mjs <sdk.mjs> <zod/index.js> <empty dir>`. Passed on 2026-10-08.
- `probe-git-ref-marker.sh` — one `git update-ref --stdin` transaction moves a branch and creates a marker ref together;
  a stale expected old value aborts both. Covers only the normal and stale paths, not kill or power loss. Passed on 2026-10-08.
- `probe-resource-limits.sh` — inside one systemd user scope with `MemoryMax=64M`: confirms the scope's own
  `memory.max`, that a 16 MB control allocation succeeds, and that a 200 MB allocation is OOM-killed (exit 137,
  `oom_kill` counted in `memory.events`). Then a bubblewrap tmpfs with `--size 1 MiB` accepts a 512 KiB control write
  and stops a 4 MiB write at 1 MiB with ENOSPC. Case 1b compares `OOMPolicy=stop` with `continue`: under `stop` an
  unrelated sibling (30 s lifetime, output to /dev/null) is gone within 5 s; under `continue` it survives. The stop is
  asynchronous (the shell still prints AFTER), which is why the design uses `memory.oom.group` instead. Passed on 2026-10-09. (The 2026-10-08 version could not tell a cap
  from a scope that never started; round-9 critique #7.)
- `probe-git-landing.sh` — lands a delivery ref onto a named branch with
  `git push --receive-pack='git -c receive.denyCurrentBranch=updateInstead receive-pack' . <ref>:refs/heads/main --force-with-lease=...`.
  Six cases: dirty checkout refused; user switched to another branch (only `main` moves); stale lease refused; clean
  checkout updated in place; clean linked worktree updated in place; untracked file in the way refused. Case 7 reproduces
  the hazard of a repository `push-to-checkout` hook that exits 0 (branch moves, files stay stale) and shows that
  `core.hooksPath=/dev/null` on both sides restores the built-in update. Case 8 checks a post-landing scan of every
  worktree: silent on a correct landing, flags the receive-side race's end state. `git -c` alone does not reach the
  receiving side of a local push. Passed on 2026-10-09 (10 checks).
- `probe-disk-image-cap.sh <fuse2fs>` — a preallocated 16 MiB ext4 image mounted unprivileged with fuse2fs: space is
  reserved up front; plain writes, writes through an unlinked open file, and writes from inside bubblewrap all stop at
  16 MiB with ENOSPC; inode count is capped; host footprint never exceeds the image. One check records a hazard
  rather than a cap: a 1 GiB sparse file fits in the 16 MiB image, so export must be metered by logical length. Passed on 2026-10-09 with
  fuse2fs 1.47.2 (Ubuntu package `fuse2fs`, extracted without installing).

- `probe-landing-config-view.sh` — repository content filters during landing. A filter whose commands append to an
  ABSOLUTE marker path written into the command text (so clearing the environment cannot hide an execution) is defined
  in the repo config and global config and injected through `GIT_CONFIG_COUNT/KEY/VALUE`. Three groups run the
  identical sequence (reset, push, back-date the file to force a content re-read so clean runs, `update-index
  --refresh`, `diff-files`, `status`): no view, where smudge runs in the push and clean in the check; view without
  `--clearenv`, where the injected clean runs in the check, proving the marker works; and view with `--clearenv`,
  where neither runs and the checkout is updated. The view keeps the `*.dat filter=evil` mapping, verified in effect.
  Observed: a local push resets the receiving side's environment, so injected config only reaches the check commands.
  A default-location `.git/hooks/post-index-change` hook also writes to the marker, and the sequence builds a temporary
  index with `read-tree`: a hook-control group (cleared env, but the view leaves `core.hooksPath` unset and `.git/hooks`
  visible) runs the hook, while the positive view, with `core.hooksPath` set to an empty read-only directory that is also
  mounted over `.git/hooks`, does not. Every step's exit status is checked. Passed on 2026-10-09 (9 checks).
- `probe-oom-group.sh` — two-layer cgroups the program owns through a delegated systemd user scope (`Delegate=yes`):
  a control leaf and a run leaf with its own `memory.max`. With `memory.oom.group=1` one OOM in the run leaf kills all
  its processes together (the shell never reaches AFTER; the sibling is gone within 5 s), and only the run leaf's own
  `memory.events.local` records `oom`/`oom_kill` while the unit level stays at zero. Negative control
  `memory.oom.group=0`: only the allocating process dies, the sibling survives. Passed on 2026-10-09 (5 checks).
- `probe-oom-attribution.sh` — which counter shows that an execution unit was killed by an OOM. Inside a delegated
  scope: pool (ancestor) > unit (`memory.oom.group=1`) > {ctl, run}. When the ancestor's limit is hit, the unit's own
  `memory.events.local` "oom" stays 0 while its hierarchical `memory.events` "oom_kill" is 3 and the control process is
  killed too; when the unit's own limit is hit, its local "oom" is 1. Passed on 2026-10-09 (6 checks).
- `probe-unit-supervisor.sh` — the unit supervisor as the main process of an independent transient systemd user
  service (`Delegate=yes`), in a leaf beside the unit subtree (`memory.oom.group=1`, own `memory.max`). The caller only
  reads the proof file afterwards. A normal host's proof carries its real exit code (7) and zero OOM counts; a host killed
  by the unit's limit leaves the supervisor alive, and its proof records 137, unit `oom` 1, `oom_kill` 4. Both proofs are
  written after the unit subtree is empty. Passed on 2026-10-09 (4 checks).
- `probe-metering-proxy.sh` (+ `probe-metering-proxy-server.mjs`) — design 6.5 / §14 item 2. One real `claude -p`
  request with `ANTHROPIC_BASE_URL` pointing at a local forwarding proxy: under the subscription login the model request
  goes through the proxy (Bearer auth passed through, status 200), the proxy reads usage from the streamed response
  (it asks upstream for `accept-encoding: identity`), and the request body in bytes (85,125) exceeds the total input
  tokens (30,231), supporting the design's "input bound = body bytes". Not covered: agreement with account-side usage,
  concurrency, proxy or host death mid-request. Passed on 2026-10-09 (4 checks).
```
bash probe-cli.sh
npm install --prefix /tmp/sdk-pkg @anthropic-ai/claude-agent-sdk
node probe-sdk.mjs /tmp/sdk-pkg/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
```

Results on 2026-10-08:

| Probe | CLAUDE.md marker seen | Disallowed command | Account connectors visible |
|---|---|---|---|
| CLI plain, `--tools Read` | yes | n/a | yes (Drive, Docs, ...) |
| CLI `--allowedTools "Bash(echo:*)"` only | — | ran (`touch` created the file) | — |
| CLI `--safe-mode --permission-mode dontAsk` | no | refused | no |
| SDK `settingSources: []`, `canUseTool` | no | refused | yes, attached asynchronously |
| SDK plus `strictMcpConfig: true, mcpServers: {}` | no | refused | no |

Without `ANTHROPIC_API_KEY` set, the SDK session reported `apiKeySource: none` and ran on the subscription login.
