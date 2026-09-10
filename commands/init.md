---
description: Initialize Mission Pipeline 2 with explicit runtime capabilities, safe legacy migration and a reviewed binding proposal.
---

# Initialize Mission Pipeline 2

Read `${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/references/setup.md` and follow it. Use the installed package's absolute script path and explicit project root. Keep `scripts/mp_runtime/` and all role/reference files alongside `scripts/mp`; the package is no longer a single-file installation.

Scout the existing project read-only, preserve its conventions and existing principal authorization, then fill any missing bindings. Do not repeat an already answered permission question. If an existing PROJECT.md and v4 manifest are present, inspect their bindings and state without overwriting them.

Probe capabilities first, initialize a fresh ledger second, and run doctor after state exists. A legacy ledger uses read-only `migrate --plan` followed by the authorized migration. Neither `init` nor migration edits historical documents or pretends old evidence satisfies new gates.

Native Windows Python 3.12+ supports local CLI checks. Linux/WSL Python 3.12+ plus working bubblewrap supports managed execution only through the trusted controller and private role tools. Register the actual interpreter, input roots and relevant non-secret environment. Use an explicit JSON request file or stdin for arbitrary text; never interpolate it into PowerShell, Bash or a WSL command string.

Managed installation must not add a broad host-shell allow rule to model roles. A host with unrestricted parallel shell/filesystem tools is local mode, even if it also invokes the broker. The trusted operator may launch the controller with `managed start` and its configured JSONL transport. Missing isolation is an explicit setup error; no silent downgrade.

The principal determines major goals, reserved decisions and grants. A grant may authorize small-direction PM choices, revision, deferral or closure. Record the actual source once through principal ingress; do not ask for every already authorized act. Mandatory supervision and closure auditing are part of schema 4 and cannot be switched off by old `--audit off` commands.

Report the selected mode, actual interpreter/capability results, bound root/ledger, migration status if applicable, and any truly missing principal decisions. Do not announce managed guarantees until the actual controller/driver/sandbox path is available.
