# Substrate — schema 4

The normal Mission Pipeline 2 command, evidence and recovery contract is [runtime-v4](runtime-v4.md), and [walkthrough](walkthrough.md) shows it running end to end. Read one of them before operating state. `scripts/mp` imports its adjacent `mp_runtime` package; it is not a standalone single-file installation.

The released schema-3 command surface remains available only through explicit compatibility mode, for old ledgers and historical regression. It refuses a ledger carrying a v4 owner or manifest. Do not use old `run record --cmd`, automatic Charter ratification, optional audit or free-form supersede commands as a workaround for v4 gates.

Original historical journals and documents retain their released meaning under migration. New semantic overlays, current execution, actual delivery bundles and scoped authority checks govern new positive uses. An obligation already delivered under 1.2 is settled with `legacy.accept`, which records it as `legacy-recorded` history rather than pretending a v4 run happened.

## Two execution substrates, named honestly

- **Local execution** is what this repository can run today. It freezes the declared inputs, checks the interpreter and import origins, runs argv with no shell interpolation, and stores stdout, stderr and declared outputs in CAS. It does **not** contain the process: the home directory and the network are reachable. Runs record `assurance="local-execution"`, and 2.0 ledgers carry the older `local-controlled-execution` label for the same thing.
- **Managed execution** adds the allowlisted bubblewrap sandbox, the private role endpoints and the broker's read receipts. It is **experimental**: the sandbox and the protocol are implemented and tested, but no model driver ships here, so a managed deployment depends on a transport somebody else supplies.

Local role labels are provenance, not authentication. Separation of seats in local mode is real only to the extent that the operator actually spawns separate agents.

Read [setup](setup.md) for supported native Windows, WSL managed, bridge, migration, writer-identity and rollback paths.
