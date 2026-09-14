# Parallel execution — reviewed scopes

Architect maps the actual producer, input, file-write and dependency relationships; PM owns the authorized scheduling choices. Independent Constructor, Crititor and Stabilizer seats receive the current original authority, the task and admission, and the actual immutable inputs.

## Waves

The first wave exists at root activation. `wave.open` for a successor requires the previous wave CLOSED and a completed aggregate calibration whose outcome is ALIGNED or SUSPICION. `wave.integrate` closes a wave after rechecking every task's current acceptance, required runs and affected barriers, exactly as task consumption does.

A task cell ALIGNED does not reset an aggregate-wave ratchet, and an ALIGNED verdict never releases a standing latch by itself.

## Write scopes

Tasks in one wave must have disjoint write scopes unless a declared sequential owner handles their integration. Use exact reviewed `write_paths`, or isolated task worktrees. `work.write` carries the expected current file hash, so a concurrent edit refuses `STALE_PRODUCT_HEAD` instead of silently overwriting another seat's work.

The calibration basis for a task covers its `outputs`, its `write_paths` and its required runs' declared inputs. A shared helper that two tasks both list in `write_paths` is therefore inside both cells: rewriting it invalidates the other task's ALIGNED cell and the acceptance resting on it. That is a reason to separate the waves, not a reason to leave the helper out of `write_paths`.

Do not give model roles unrestricted host filesystem access in managed mode. In local mode nothing stops a role from writing anywhere, so the reviewed path list is the discipline, and `work.write` is the only path the engine can actually check.

## Holds and unrelated work

A mandatory case fences its own tasks and obligations. Unrelated scopes proceed while it is screened, and an already queued ticket stays valid unless its own fence changed. A mission-wide case, a DRIFT latch or an aggregate ratchet is the case that stops a fan-out.

## Execution and publication

Long execution runs outside the journal writer lock, with finite leases, heartbeats and a total deadline. A run whose owner session died can be aborted by pm or controller once its lease has expired. Read-only queries mutate no schema and publish no views. Publication renders outside the lock and rechecks epoch and sequence before replacing a view.

Do not delete a worktree until its authorized integration is recorded and its delivered artifacts are preserved.

## Seams

A shared seam needs actual end-to-end verification through its declared real producers, not two unrelated mock successes. A valid stage-specific mission may hand off later work to a named authorized owner; it must not silently omit a goal its own principal actually required.
