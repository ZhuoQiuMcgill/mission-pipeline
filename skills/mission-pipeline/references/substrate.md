# Substrate — schema 4

The normal Mission Pipeline 2 command, evidence and recovery contract is [runtime-v4](runtime-v4.md). Read that document before operating state. `scripts/mp` imports its adjacent `mp_runtime` package; it is not a standalone single-file installation.

The released schema-3 command surface remains available only through explicit compatibility mode for old ledgers and historical regression. It refuses a v4 owner/manifest. Do not use old `run record --cmd`, automatic Charter ratification, optional audit or free-form supersede commands as a workaround for v4 gates.

Original historical journals and documents retain their released meaning under migration. New semantic overlays, current controlled execution, actual delivery bundles and scoped authority checks govern new positive uses. Read [setup](setup.md) for supported native Windows, WSL managed, bridge, migration and rollback paths.
