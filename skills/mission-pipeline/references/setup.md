# Setup — Mission Pipeline 2

Install or update the entire skill directory. The script imports `scripts/mp_runtime/` and loads `roles/` at runtime; a standalone copy of `mp` is unsupported. Keep project bindings in `.claude/mission-pipeline/PROJECT.md`. Engine updates do not overwrite those bindings or the real ledger.

## Runtime and root binding

Use an absolute interpreter and script path. Supported native/local hosts have Python 3.12+ with SQLite; Git supplies identity in Git-backed projects. Managed hosts additionally require working Linux/WSL bubblewrap namespaces. This repository's tested interpreters are Windows 3.12.7 and Ubuntu WSL 3.14.4.

Choose the main project root explicitly with `--root`. From an arbitrary working directory, this remains the only target. The optional `.claude/mission-pipeline/mp.json` contains `{"ledger":"ledger"}` or an explicit absolute ledger path. Invalid JSON fails; it does not silently select another ledger.

For a fresh project, the agent invokes the following in order (replace the path placeholders with actual argv elements):

```text
python <skill>/scripts/mp --root <project> capabilities
python <skill>/scripts/mp --root <project> init
python <skill>/scripts/mp --root <project> doctor
```

`init` chooses schema 4 and local provenance. It establishes an atomic writer-environment owner and publishes READY only after the manifest and database are complete. Existing v4 state is inspected, not reset. `doctor` is a state health check; it cannot inspect a database before initialization.

For existing released ledgers, use `migrate --plan --source-root <project>` to review provenance and overlays, then `migrate --source-root <project>` under existing migration authorization. Migration preserves raw history, freezes the legacy writer and imports its exact replay semantics plus current semantic overlays. Open scopes need `legacy.adopt`; closed scopes remain closed. `rollback` is allowed only before a v4 business transition. New source documents never fill an old missing hash.

## Managed controller

Run `managed probe`, then `managed start` in the owner Linux/WSL environment. These commands exercise the real allowlisted sandbox; checking that the bwrap binary exists is insufficient.

The trusted model transport is a JSONL process launched with private stdin/stdout pipes. A configuration file contains an argv array and `"parallel_host_tools": false`. This flag documents the host contract; the trusted operator must actually remove other model tool access. The broker never turns a role request into a host shell command, exposes no bearer credential file, and has no model-visible principal-ingress tool.

`managed principal --request-file <file>` is the trusted principal console. `managed run --role <role> --mission <id> --driver-config <file>` starts an independently scoped role. `managed run --job <job-id> --driver-config <file>` assigns the bounded stored screening or contest lineage. After UPHOLD and actual accepted repair, a fresh controller uses the same job id plus `--repair-file <json>` (for example `{"repair_tasks":["T1"]}`) to claim its independent compliance generation. The transport must explicitly refresh changed packets and read actual immutable blobs; review submissions cannot acquire unread current metadata at commit. `mp_runtime.reference_driver` demonstrates the framing; connect a real model transport with the same protocol, not an assumed host SDK.

Constructor can submit content blobs, use admitted `work.write` paths, and invoke controlled `run.execute`. The executor exposes frozen product inputs read-only and an output directory. Declared `/out` files are exported to scoped delivery paths and CAS before temporary directories disappear. Neither import preflight nor the product command sees the host project, private ledger, home or host network.

## Windows / WSL bridge and ownership

The native bridge invokes `wsl.exe --distribution <name> --exec <python> <entry> --bridge-stdio` as an argv array. All request text travels once as UTF-8 JSON on stdin. Supply an explicit absolute Linux entry and an explicit mapped Linux root in the request. Include the ledger `project_id` after initialization to reject a mistaken root mapping. Do not infer a Windows drive path as a POSIX filename.

`mp bridge wsl --entry <linux-entry> --request-file <file>` supports ordinary local requests and trusted controller operations (`managed.start`, `managed.principal`, `managed.run`). A `managed.run` bridge request can name `job` and optional `repair` with the same JSON fields as `--repair-file`; ordinary runs name `role` and `mission`. Role packets never expose this trusted-console transport.

Windows and WSL do not concurrently write the same ledger. The owner environment runs `maintenance handoff --target-environment <id>` after active execution ends; the named destination runs `maintenance accept`. Every handoff increments the epoch; old sessions and writers are fenced. Interrupted same-owner bootstrap uses `maintenance recover`. A live legacy or foreign writer is never silently forced aside. An owner directory with no valid owner record requires an operator to establish offline quiescence before repairing that manifest; normal writers remain refused.

## Product environments

`env inspect --request-file <file>` checks the selected interpreter, cwd, required modules and project module origins. `env create` creates a fresh `--without-pip` venv at a new path, leaving a copied environment intact for diagnosis. Supply project dependencies through the project's canonical environment provisioning; missing dependencies stay explicit errors. Managed registered Linux venvs use a specific `runtime_root` with `pyvenv.cfg`, mounted read-only at `/runtime`.

Register an `expected_version` when the canonical Python version matters. Requirements fix argv, cwd, explicit input paths, environment id, success predicate and output mappings. Canonical profiles fix Compose `-f`, build contexts and bind-source roots; ambient `COMPOSE_FILE` and `PYTHONPATH` are excluded. Only the allowlisted relevant environment values are recorded; credentials are not dumped or fingerprinted as low-entropy secrets.

Native file operations use UTF-8 protocol boundaries and extended Win32 paths where needed. Git NUL-delimited path bytes are decoded explicitly. CRLF and LF remain different raw identities. Unsupported target filenames or unmapped paths fail with a specific path error.

## Principal bindings

Scout existing code, verification scripts, documentation and task naming before requesting new input. Preserve existing authorization. Record original direction, reserved conditions, grant domains/scope/permissions, actual canonical verification profile and optional stage handoff ownership. PM choices inside that grant proceed autonomously. A normal scope-specific deferral requires its grant, responsible owner and disclosed gap; it is not proof of repair.

Read [runtime-v4](runtime-v4.md) for the typed request lifecycle and recovery contract. Installing this release does not migrate real ledgers or run production tasks.

The typed lifecycle includes `contracts.snapshot` before local root/plan judgments. Preserve its `contract_scope_digest` while reading the named original sources, and submit that exact digest with the judgment. Managed packets supply the corresponding actual-read receipt. Project standing constraints remain applicable to other missions until their explicit principal retirement or declared expiry. New product/run evidence requires a current task calibration when mandatory; unchanged TaskSpec alone does not authorize reuse of an old ALIGNED cell.
