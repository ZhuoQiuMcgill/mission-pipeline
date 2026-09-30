# Mission Pipeline 3.0 receipt workflow

Version 3.0.0 adds execution and exploration routing to schema 4. Existing tasks
without `work_type` keep the original v4 policy. Select the route explicitly for
new subtasks. Historical acceptance keeps its policy; lineage budgets never reset.
Upgrade by replacing the whole skill package. Project ledgers stay in place.
Existing admissions keep their historical policy; a new admission needs a review
that binds the complete verification definitions. Refresh a pre-upgrade planning
review before issuing a new admission.

## Plan with the user

PM records original user words and delegation, obtains root MATCH and activation,
then publishes goal-linked obligations and a prioritised task graph. A parent can
have both execution and exploration children. Dependencies determine eligibility;
larger integer priorities run first, with stable id as tie breaker. PM owns design
choices and communicates material tradeoffs to the user. Secretary handles only
recorded operational delegation.

Use `work_type: "milestone"` for future scope whose executable details are still
undecided. Milestones have no workers, writes, outputs or runs. Refine them into
producing children. They grant no acceptance credit. User authority, goal coverage,
independent root/planning review, formal cases and final closure remain shared.

## Task and review contract

`task.record` retains the shared fields in [runtime-v4](runtime-v4.md) and adds:

Use [the receipt task template](../templates/receipt-task.md) for a concrete sealed
work order. One parent may have children of both types.

| Field | Meaning |
|---|---|
| `work_type` | `execution`, `exploration` or `milestone`; execution selects `fast` policy |
| `parent` | Optional same-mission parent id; hierarchy and dependencies cannot cycle |
| `priority` | Initial integer scheduling priority, stored outside the contract |
| `owner` | Responsible owner, default `pm` |
| `criteria` | Stable criterion ids mapped to agreed descriptions; covers all obligation ids |
| `workers` | Distinct `{id, write_paths, outputs, session?}` assignments covering exactly the task paths |
| `prerequisites` | Explicit input conditions `{path, sha256?}`; assigned construction outputs are not prerequisites |
| `decision_dependencies` | Stable ids of PM choices needed before construction |
| `specialist_review` | Require a separate Crititor PASS on an execution candidate when true |
| `routing_reason_blob` | Required when revising an already routed task to another work type |

Worker write/output paths must be disjoint, including aliases. Shared integration
uses a dependent integration subtask: it reads accepted parallel outputs, owns the
integrated artifact and runs seam checks. Exact paths can be in separate work
locations; the runtime does not create checkouts for workers.

Define every `requirement.record` before executable review. A listed id alone is
insufficient. Full argv, environment, inputs, predicates and output destinations
are bound to review and admission. Routed requirements name `worker`; it defaults
to the sole worker for single-worker tasks. Multi-worker checks need an explicit
assignment, and exported destinations belong to that worker.

`plan.review` may specify `active_tasks` within its `tasks` graph. Goal coverage
includes later milestones; only active executable leaves need complete definitions.
Only those leaves can be admitted from that review. Routed admission binds the
reviewed leaf contract; unrelated sibling changes do not stale it. Changed leaf
behavior or check definitions require new review/admission. Historical v4 tasks
retain their graph-wide review interpretation.

`schedule.record` (PM) changes `{task, priority, source_blob}` without changing
the contract. Use it for queue changes instead of rewriting a task.

## Delegate coordination

PM submits `secretary.delegate` with `id`, `mission`, a current PM `decision`,
explicit `tasks`, `operations`, `source_blob`, optional Unix `expires` and finite
`max_actions` (default 100). Operations: `issue`, `dispatch`, `refresh`, `repair`,
`schedule`, `escalate`. Optional `priority_range: [minimum, maximum]` permits routine
queue updates within that range. Material priority changes outside it go to PM.

Every Secretary mutation rechecks its decision, grant, authority, scope, expiry
and action budget. Managed endpoints cannot change role; local role labels remain
self-asserted provenance.

`secretary.coordinate` takes `{task, delegation, operation, source_blob}`:

- `refresh`: record qualified state and coordination basis.
- `schedule`: select an already defined and admitted producer. Optional `priority`
  needs the delegated range. New behavior, criteria or graph edges require PM and
  review. An approved prerequisite may be issued directly from its scoped review.
- `repair`: route a concrete independent in-contract repair within the remaining
  three-cycle lineage budget; cannot waive cases, latches or principal constraints.
- `escalate`: record the precise gap and evidence for PM. PM decides and aligns
  with the user. Accepted exploration findings alone never create a design choice.

PM keeps complete ledger access. Compact default packets contain current reports,
the latest attempts and the current construction cycle; old cycles and annotations
stay in the ledger. `query` retrieves original records; `full: true` includes parsed report
fields. Managed `refresh_packet` with `full: true` returns complete mission records.
Original source bytes remain available by immutable CAS reference. A worker's full
packet remains within its task/dependency scope; PM can request the whole mission.

## Receipt sequence

Mutations use `{request_id, action, data}` through the standard public CLI:

```text
python <skill>/scripts/mp --root <project> --actor <seat> api --request-file request.json
```

| Step | Seat and action | Data |
|---|---|---|
| Issue | Secretary `receipt.issue` | `{id?, task, delegation, review}` or existing `admission`; optional recovery `permit` when issuing from review |
| Inspect | Architect `receipt.snapshot` | `{receipt}`; frozen contract and current prerequisite `basis` or gaps |
| Readiness | Architect `readiness.record` | `{receipt, outcome, basis, source_blob}`; non-READY needs `gaps` |
| Dispatch | Secretary `receipt.dispatch` | `{receipt, delegation}`; rechecks readiness, dependencies, decisions, collisions and budget |
| Claim | Constructor `receipt.claim` | `{receipt, worker}`; records the actor instance's assignment |
| Build/verify | Constructor `work.write`, `run.execute`, `delivery.record` | Existing shared fields; writes and exports must fit the claimed worker |
| Complete execution | Constructor `completion.record` | `{receipt, claim, source_blob, gaps?}`; runtime fills changes, outputs and runs |
| Inspect candidate | Stabilizer `acceptance.snapshot` | `{receipt}`; actual integrated candidate and current evidence |
| Accept execution | Stabilizer `acceptance.record` | `{receipt, outcome, basis, source_blob, criteria, critique?}`; nonacceptance needs `findings` |
| Continue | Runtime and Secretary | `queue.snapshot {mission}` exposes qualified states, eligible work and escalations |

A receipt has stable id, version, predecessor, immutable contract, admission,
route and lineage. A material contract or relevant admission-basis revision
supersedes it. Do not reissue a receipt to
reset a repair budget. Architect READY binds actual input bytes, interpreter and
registered libraries, accepted dependencies, decisions and authority. Missing input
interfaces block readiness; missing assigned outputs are expected construction.

Managed `read_product {task, path}` reads only declared product, prerequisite or
verification input paths. Architect reads current prerequisites before READY.
Inspection tools cannot write, open cases, expire jobs or change queues. Source
availability is checked automatically; the Architect's source explains inspection
of service behavior, interface semantics and other prerequisite facts.

Parallel workers complete independently. Each completion checks its own outputs
and assigned required runs. All workers must finish and the integrated candidate
must remain current before acceptance. Missing completion blocks acceptance;
cross-receipt write collisions and stale file replacements are refused.

## Acceptance and repair

Execution uses one independent Stabilizer acceptance over every criterion, actual
output bytes, satisfied runs and cross-worker seams. Submit the exact `basis` from
`acceptance.snapshot`. `criteria` maps each agreed id to
`{status: "met", evidence: [...]}`. Evidence names current output hashes, completion
source hashes or run ids/stdout/stderr hashes. Read actual evidence and explain
the judgment in `source_blob`. Acceptance must come from a different instance than
every Constructor. PM, Secretary and Architect cannot accept products. A declared
specialist Crititor PASS must judge this same candidate independently.

Reviewers can use `run.execute` with `purpose: "independent_check"` and a concrete
`reason`. Identical successful execution preserves the completed fast-mode product
and its construction cycle. Refresh the acceptance snapshot to bind the latest run
evidence. Changed product bytes or failed required checks block acceptance.

Outcomes: `ACCEPTED`, `REPAIR_REQUIRED`, `NEEDS_DECISION`, `INPUT_INCOMPLETE`.
Concrete repairs go through Secretary routing and another construction cycle;
important design changes go through PM. One initial candidate plus two repairs
is the cap across replacements and rerouting. Failed local checks remain run
evidence and do not each need three reports or a PM handoff.

`completion.annotate {completion, source_blob}` preserves a worker's explanation
without changing product facts or spending a cycle. An INPUT_INCOMPLETE acceptance
can name its predecessor through `revises` after the reviewer reads the missing
evidence; accepting the same qualified candidate does not consume another cycle.

Exploration shares issue/readiness/dispatch/claim coordination, then keeps the
development, Crititor and Stabilizer reports and calibration gates. Use the
dispatch's cycle as report `round`. Criteria can describe honest negative or
inconclusive findings under agreed stopping conditions. A downstream decision
edge stays blocked until PM records its choice.
Multi-worker exploration records each worker's completion before its aggregate
development report; a single-worker COMPLETE report records completion atomically.
Its positive review criteria cover every agreed criterion, including investigation
questions and stopping conditions beyond the goal obligation ids.

## Qualified state and closure

`queue.snapshot` is read-only. It separates recorded acceptance milestones from
current qualification and shows parent/type/priority, dependencies and unlocks.
States include PLANNED, ISSUED, BLOCKED, NEEDS_DECISION, READY, RUNNING, CONSTRUCTED,
ACCEPTED, REPAIR_REQUIRED, INPUT_INCOMPLETE, STALE, DEFERRED and CANCELLED. Only
accepted current outputs satisfy output prerequisites. Historical ACCEPTED records
remain traceable when their evidence goes stale.

`task.dispose` (PM/principal) uses
`{task, outcome: "DEFERRED"|"CANCELLED", grant, owner, source_blob}`. Its defer grant
is rechecked; goal obligations still need their own authorised dispositions. A
disposed task never provides acceptance credit or unlocks dependent work.

For routed work, `bundle.record target:<task id>` includes the task's dependency
and parent scope. Unrelated unfinished tasks do not block it. Final closure requires
the full mission bundle, mandatory Auditor/Supervisor reviews, qualified outcomes,
current closing run and valid closure authority. Formal cases and latches keep
their existing recovery path. Rejected legacy replay transactions remain original
history and diagnostics and cannot create qualified contracts or acceptance credits.
