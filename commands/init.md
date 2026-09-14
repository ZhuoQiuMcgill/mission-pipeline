---
description: Initialize Mission Pipeline 2 with explicit runtime capabilities, safe legacy migration and a reviewed binding proposal.
---

# Initialize Mission Pipeline 2

Read `${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/references/setup.md` and follow it. Read `${CLAUDE_PLUGIN_ROOT}/skills/mission-pipeline/references/walkthrough.md` before running the first mission: it is the complete request sequence, including the mid-mission upgrade path for a 1.2 deployment. Use the installed package's absolute script path and an explicit project root. Keep `scripts/mp_runtime/` and all role, template and reference files alongside `scripts/mp`; the package is not a single-file installation.

Scout the existing project read-only, preserve its conventions and its existing principal authorization, then fill any missing bindings. Do not repeat an already answered permission question. If an existing PROJECT.md and v4 manifest are present, inspect their bindings and state without overwriting them.

Probe capabilities first, initialize a fresh ledger second, and run doctor after state exists. Run `status` after `init` and record the `owner.project` id it prints; `maintenance takeover` requires it. A legacy ledger uses read-only `migrate --plan` followed by the authorized migration; an open legacy mission then needs `legacy.adopt`, and an obligation it already delivered is settled with `legacy.accept`. Neither `init` nor migration edits historical documents or pretends old evidence satisfies new gates.

Native Windows or POSIX Python 3.12+ supports local operation. Local mode enforces every data and state check, and its role labels are self-asserted: separation of seats depends on actually spawning separate agents. Local execution freezes declared inputs and captures logs and outputs, and does not contain the process, so do not describe it as sandboxed.

Managed mode is experimental. Linux/WSL Python 3.12+ plus working bubblewrap provides the isolation, but this repository ships no model driver, so a managed deployment needs a trusted JSONL transport supplied separately. Do not add a broad host-shell allow rule for model roles: a host with unrestricted parallel shell or filesystem tools is local mode even when it also invokes the broker. Missing isolation is an explicit setup error, never a silent downgrade.

Register the actual interpreter, input roots and relevant non-secret environment. Use an explicit JSON request file or stdin for arbitrary text; never interpolate it into PowerShell, Bash or a WSL command string. After upgrading the installed skill on a Windows plus WSL deployment, re-register the bridge mappings before the first cross-platform request.

The principal determines major goals, reserved decisions and grants. A grant may authorize small-direction PM choices, revision, deferral or closure. Record the actual source once through principal ingress; do not ask again for every already authorized act. Mandatory supervision and closure auditing are part of schema 4 and cannot be switched off by old `--audit off` commands.

Report the selected mode, the actual interpreter and capability results, the bound root and ledger, the `owner.project` id, migration status if applicable, and any genuinely missing principal decisions. Do not announce managed guarantees until the actual controller, driver and sandbox path exists.
