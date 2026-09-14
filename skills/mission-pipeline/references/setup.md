# Setup — Mission Pipeline 2

Install or update the entire skill directory. The script imports `scripts/mp_runtime/` and loads `roles/` at runtime; a standalone copy of `mp` is unsupported. Keep project bindings in `.claude/mission-pipeline/PROJECT.md`. Engine updates do not overwrite those bindings or the real ledger.

Read [walkthrough](walkthrough.md) for the complete request sequence of a first mission, and [runtime-v4](runtime-v4.md) for the contract each request is checked against.

## Runtime and root binding

Use an absolute interpreter and script path. Supported native and local hosts have Python 3.12+ with SQLite; Git supplies identity in Git-backed projects. Managed hosts additionally require working Linux/WSL bubblewrap namespaces. This repository's tested interpreters are Windows 3.12.7 and Ubuntu WSL 3.14.4.

Choose the main project root explicitly with `--root`. From an arbitrary working directory, this remains the only target. The optional `.claude/mission-pipeline/mp.json` contains `{"ledger":"ledger"}` or an explicit absolute ledger path. Invalid JSON fails; it does not silently select another ledger.

For a fresh project, the agent invokes the following in order (replace the path placeholders with actual argv elements):

```text
python <skill>/scripts/mp --root <project> capabilities
python <skill>/scripts/mp --root <project> init
python <skill>/scripts/mp --root <project> doctor
```

`init` chooses schema 4 and local provenance. It establishes an atomic writer-environment owner and publishes READY only after the manifest and database are complete. Existing v4 state is inspected, not reset. `doctor` is a state health check; it cannot inspect a database before initialization.

After `init`, run `status` and record `owner.project` from the owner record it prints. `maintenance takeover` requires that exact project id, and the `init` response itself does not carry it.

For existing released ledgers, use `migrate --plan --source-root <project>` to review provenance, overlays and recovered acceptances, then `migrate --source-root <project>` under existing migration authorization. Migration preserves raw history, freezes the legacy writer and imports its exact replay semantics plus current semantic overlays. Open scopes need `legacy.adopt`, and an already delivered obligation is settled with `legacy.accept`; closed scopes remain closed. `rollback` is allowed only before a v4 business transition. New source documents never fill an old missing hash. Part 2 of the [walkthrough](walkthrough.md) is the mid-mission upgrade path in full.

## Writer identity and ownership

The writer identity is `sha256(platform family, token)[:24]`. The token lives in `<config dir>/mission-pipeline/writer-id`, created with random hex on first use: `$XDG_CONFIG_HOME` or `~/.config` on POSIX, `%APPDATA%` on Windows. It is not inside the ledger, so back it up alongside the ledger when you archive a project.

Because the identity no longer hashes the hostname, renaming a machine, renaming a WSL distribution or launching from cron or systemd does not lock the ledger. Ledgers written by 2.0 keep their old identity and are still accepted; `maintenance recover` rewrites the owner record to the new form.

If the owner environment really is unreachable, the principal claims the ledger with `maintenance takeover --confirm <project id>`, which installs a new environment, increments the epoch and records `takeover_from`. It is a principal act and it is journaled.

Windows and WSL do not concurrently write the same ledger. The owner environment runs `maintenance handoff --target-environment <id>` after active execution ends; the named destination runs `maintenance accept`. Every handoff increments the epoch, and old sessions and writers are fenced. Interrupted same-owner bootstrap uses `maintenance recover`. A live legacy or foreign writer is never silently forced aside. An owner directory with no valid owner record requires an operator to establish offline quiescence before repairing that manifest; normal writers stay refused.

## Managed controller (experimental)

Managed mode is implemented and tested, but **this repository ships no model driver**. A managed deployment needs a trusted JSONL transport somebody writes for it, so treat managed mode as experimental and describe a mission as isolated only after the real path exists.

Run `managed probe`, then `managed start` in the owner Linux/WSL environment. These commands exercise the real allowlisted sandbox; checking that the bwrap binary exists is insufficient.

The transport is a JSONL process launched with private stdin and stdout pipes. Its configuration file contains an argv array and `"parallel_host_tools": false`. That flag documents the host contract; the trusted operator must actually remove every other model tool. A host that keeps unrestricted parallel shell or filesystem tools is running in local mode whatever the configuration says. The broker never turns a role request into a host shell command, exposes no bearer credential file, and has no model-visible principal-ingress tool.

`managed principal --request-file <file>` is the trusted principal console. `managed run --role <role> --mission <id> --driver-config <file>` starts an independently scoped role; one run is one packet, at most 32 steps and 300 seconds. `managed run --job <job-id> --driver-config <file>` assigns the bounded stored screening or contest lineage. After UPHOLD and an actual accepted repair, a fresh controller uses the same job id plus `--repair-file <json>` (for example `{"repair_tasks":["T1"]}`) to claim its independent compliance generation. `mp_runtime.reference_driver` demonstrates the framing; connect a real model transport with the same protocol, not an assumed host SDK.

Constructor can submit content blobs, use admitted `work.write` paths and invoke `run.execute`. Under the managed executor, neither the import preflight nor the product command sees the host project, the private ledger, the home directory or the host network. **Local execution has none of that containment**: it freezes the declared inputs, records the interpreter and import origins and captures logs and outputs, and records `assurance="local-execution"`. Say so plainly rather than calling a local run controlled.

## Windows / WSL bridge and upgrades

The native bridge invokes `wsl.exe --distribution <name> --exec <python> <entry> --bridge-stdio` as an argv array. All request text travels once as UTF-8 JSON on stdin. Supply an explicit absolute Linux entry and an explicit mapped Linux root in the request. Include the ledger `project_id` after initialization to reject a mistaken root mapping. Do not infer a Windows drive path as a POSIX filename.

`mp bridge wsl --entry <linux-entry> --request-file <file>` supports ordinary local requests and trusted controller operations (`managed.start`, `managed.principal`, `managed.run`). A `managed.run` bridge request can name `job` and an optional `repair` with the same JSON fields as `--repair-file`; ordinary runs name `role` and `mission`. Role packets never expose this trusted-console transport.

**After upgrading the installed skill, re-register the bridge mappings before the first cross-platform request.** The registration binds filesystem identities, the distribution, the interpreter and the entry path, all of which an upgrade can move. Re-run `mp bridge wsl` with the current `--entry`, and after an intentional root replacement choose a new `--mapping-file` after inspecting the actual new root rather than silently retargeting the old one.

## Product environments

`env inspect --request-file <file>` checks the selected interpreter, cwd, required modules and project module origins. `env create` creates a fresh `--without-pip` venv at a new path, leaving a copied environment intact for diagnosis. Supply project dependencies through the project's canonical environment provisioning; missing dependencies stay explicit errors. Managed registered Linux venvs use a specific `runtime_root` with `pyvenv.cfg`, mounted read-only at `/runtime`.

Register an `expected_version` when the canonical Python version matters. Requirements fix argv, cwd, explicit input paths, environment id, success predicate and output mappings. Canonical profiles fix Compose `-f`, build contexts and bind-source roots; ambient `COMPOSE_FILE` and `PYTHONPATH` are excluded. Only the allowlisted relevant environment values are recorded; credentials are not dumped or fingerprinted as low-entropy secrets.

Native file operations use UTF-8 protocol boundaries and extended Win32 paths where needed. Git NUL-delimited path bytes are decoded explicitly. CRLF and LF remain different raw identities. Unsupported target filenames or unmapped paths fail with a specific path error.

## Principal bindings

Scout existing code, verification scripts, documentation and task naming before requesting new input. Preserve existing authorization. Record original direction, reserved conditions, grant domains, scope and permissions, the actual canonical verification profile and optional stage handoff ownership. PM choices inside that grant proceed autonomously. A normal scope-specific deferral requires its grant, a responsible owner and a disclosed gap; it is not proof of repair.

The typed lifecycle includes `contracts.snapshot` before local root and plan judgments. Preserve its `contract_scope_digest` while reading the named original sources, and submit that exact digest with the judgment; `mp seal` fills it in local mode. Project standing constraints remain applicable to other missions until their explicit principal retirement or declared expiry. New product or run evidence requires a current task calibration when mandatory; an unchanged TaskSpec alone does not authorize reuse of an old ALIGNED cell.

Installing this release does not migrate real ledgers or run production tasks.
