# mission-pipeline

A supervised engineering workflow with separate Constructor, Crititor and Stabilizer seats, a PM that can make decisions within the principal's delegation, and an independent Supervisor that checks the translation from intent to work.

**Version 2.0.0** changes the normal CLI and introduces journal schema 4. Read the migration and installation requirements below before updating an existing deployment.

The principal sets the direction and reserved conditions. The PM may choose and revise methods inside a recorded delegation. A proposed Charter becomes active only after an independent semantic review; a PM-written prohibition does not silently become a principal contract. Mandatory counterexamples immediately block affected positive uses, with bounded repair and independent contest paths. Mandatory closure auditing, current execution evidence and actual delivery inputs are part of the same gate.

## Install and supported environments

Install the plugin using the existing marketplace entry, or copy the **entire** `skills/mission-pipeline/` directory. Keep `scripts/mp`, `scripts/mp_runtime/`, `scripts/mp.ps1`, roles, templates and references together. Copying the former single `mp` file is insufficient.

- Native Windows CLI: Python 3.12 or newer, standard library including SQLite, and Git for Git-backed source identity. Native mode enforces data and workflow checks; role labels are self-asserted.
- Linux/WSL managed runner: Python 3.12 or newer, Git and working `bubblewrap` user/mount/PID/network namespaces. The controller probes the actual allowlisted sandbox. Tested interpreters are Windows Python 3.12.7 and Ubuntu WSL Python 3.14.4.
- Managed roles receive only private broker tools through a trusted JSONL model transport. A transport with parallel unrestricted shell or filesystem tools cannot claim managed isolation. Missing host capability is an error, never an automatic downgrade.
- Product dependencies belong to an explicitly registered canonical interpreter/profile. A copied venv is not assumed valid. Managed Linux venvs may be mounted as a specific read-only runtime root; Windows venvs cannot be reused as Linux environments.

Run `/mission-pipeline:init`, which follows [setup](skills/mission-pipeline/references/setup.md). Agents operate the machinery; the principal supplies decisions in conversation. Existing authorization remains valid and is not requested again for each tool call.

```text
python <absolute-skill>/scripts/mp --root <absolute-project> capabilities
python <absolute-skill>/scripts/mp --root <absolute-project> init
python <absolute-skill>/scripts/mp --root <absolute-project> doctor
```

On Windows, an explicit Python executable or `scripts/mp.ps1` is supported. Requests with arbitrary text use a UTF-8 JSON file or stdin, never a shell command assembled from that text.

## Normal workflow

1. Record original principal input and scoped grants through the trusted ingress (or clearly marked local provenance).
2. Create an intake, propose a candidate, obtain `root.review`, then atomically `root.activate`.
3. Record PM choices, goal-linked obligations, feasible tasks, explicit input/write/output paths and verification requirements. Obtain a plan review and admission.
4. Constructor uses `work.write` for authorized product files and `run.execute` for controlled verification. Runs freeze explicit inputs, capture logs in CAS, and preserve declared output artifacts.
5. Crititor and Stabilizer read actual inputs and submit separate reports. PASS, ACCEPTED, dispatch, claim, integrate, consume and close recheck current scoped barriers and evidence.
6. A mandatory counterexample atomically creates its screening job and barrier. Recovery permits allow bounded repair within existing authority. Mandatory Auditor disagreement automatically starts one independent Contest; its result applies directly.
7. Build the complete immutable delivery bundle, obtain the mandatory Auditor and Supervisor closure reviews, satisfy the canonical closing run, and close under a valid principal decision or delegated close permission. Authorized deferral retains its true gap and responsible owner.

The complete request contract, role transport and recovery commands are in [runtime-v4](skills/mission-pipeline/references/runtime-v4.md). Old free-form CLI commands cannot bypass schema-4 gates.

## Storage, migration and recovery

Schema 4 uses checksummed event envelopes in `ledger/segments/`, immutable blobs, a runtime manifest, an explicit writer-environment owner and derived `mp.db`. A durable journal append is a committed operation even if SQLite subsequently fails: retry the same request id to recover its unique receipt. `doctor` distinguishes storage, semantic overlays and workflow holds; `rebuild` derives state again without replacing an open SQLite inode.

`migrate --plan` inspects a legacy ledger without changing it. `migrate` preserves the original journal and documents, freezes the old writer, replays the released dispatcher, and installs semantic overlays plus calibration-release history before READY. Open scopes require explicit `legacy.adopt`; old acceptance is historical until requalified. Closed missions remain closed. `rollback` is available only before the first v4 business transition and preserves retired v4 evidence.

A ledger has one writer environment. Windows and WSL locks are not treated as interoperable. Use the actual WSL JSON bridge, or the explicit `maintenance handoff` / `maintenance accept` epoch protocol. `maintenance recover` repairs an interrupted bootstrap in its owner environment. [Setup](skills/mission-pipeline/references/setup.md) explains these boundaries.

## Validation and compatibility

The eight released-schema regression entry points (`m1_smoke`, `m1_acceptance`, `m2_lint` through `m7_runs`) explicitly select frozen v3 compatibility. That compatibility path refuses every ledger carrying a v4 owner or manifest. New suites exercise the normal v4 path, managed role protocol, source/authority gates, historical migration and Windows/WSL environments.

`MP_COMPAT_V3=1` is a compatibility and historical regression switch, not the recommended product entry. Existing field adapter evidence is preserved; the supported replacement is `mp_runtime.field_adapter`, which uses structured requests, read-only queries and fenced publication.

## Versioning

Changes to the command, contract or schema require a major version. The plugin manifest is the installation/update metadata source; the changelog and release tag carry the same version. Release assets are available on [GitHub Releases](https://github.com/ZhuoQiuMcgill/mission-pipeline/releases).

[MIT](LICENSE) © 2026 Zhuo Qiu

The validation inventory is the 22 entry points from `tests/m1_*.py` through `tests/m21_*.py`: released v3 compatibility, normal v4 gates, real managed recovery and canonical adapter protocol, public CLI lifecycle, dual-environment/path boundaries, locked local dependency repair, current review inputs, cross-mission contracts, calibration dependencies and bounded run recovery. Run all entry points on native Windows and WSL; managed-only suites use the actual Windows-to-WSL transport from their native entry. Source and evidence manifests determine which exact version a result validates.
