# Fast mode receipt lifecycle and delegated coordination

Date: 2026-09-30. Status: implementation design for 3.0.0, following the principal's discussion with PM.

This design keeps user alignment, design decisions and an immutable ledger, while giving execution subtasks a shorter construction loop. PM translates the user's requirements into a prioritised dependency graph. A Secretary coordinates work within recorded decisions. The Architect checks environment prerequisites before construction. Constructors may work in parallel, followed by one independent acceptance check over the integrated result for the current receipt.

The 3.0.0 runtime implements this lifecycle with additive schema-4 records. Existing
ledger policy meanings are preserved. See the operational contract in
`skills/mission-pipeline/references/fast-mode.md` for implemented requests. Shared
integration uses a dependent integration subtask; Secretary schedules predefined
reviewed producers, while new definitions and graph edges go through PM and review.

## Decisions established in the discussion

- PM remains the bridge to the user and owns requirements interpretation, design decisions and the overall task list.
- A parent task can contain execution and exploration subtasks. Routing occurs at the subtask level.
- Each subtask shows its priority, dependencies, expected outputs and the work it will unlock.
- The Architect checks whether actual prerequisites support the planning receipt. Missing prerequisites return through the Secretary to the appropriate planning level.
- Ready Constructors can proceed in parallel when dependencies and write scopes allow. Acceptance follows completion of the Constructors assigned to the current receipt or batch.
- The Secretary resolves routine coordination under recorded decisions and escalates important design questions to PM. PM communicates material decisions and tradeoffs to the user.
- The Secretary reduces routine material automatically pushed into PM's active context. PM keeps access to the complete ledger and can inspect any relevant original record or evidence.

The detailed lifecycle, delegation limits and acceptance rules below define the 3.0.0 operating model. The operational reference lists its concrete runtime requests.

## Shared alignment and planning

Keep the user's original words, goals, reserved constraints and delegation as the authority for the mission. Keep the Charter, independent root review and activation. PM records design decisions within that authority and translates every required outcome into obligations and producing subtasks. Supervisor plan review checks that translation and its feasibility before work is admitted.

The planning review covers the active scope, its prerequisite contracts and the explicit later milestones required for goal coverage. Future outputs are planned obligations; their absence is not a missing delivery of already completed work.

PM's task graph gives each subtask a stable id and parent, work type, priority, dependencies, expected outputs, criteria, work scope, owner and budget. Dependencies identify the accepted output or decision they require. A graph edge can therefore require a particular interface version or a recorded design choice, rather than just the existence of a task id.

Dependencies determine eligibility. Priority orders eligible subtasks using PM's recorded scheduling policy. Independent eligible subtasks can run together. A changed queue position or progress timestamp is scheduling metadata and does not change a reviewed execution contract.

## Routing execution and exploration

An execution subtask delivers a result whose relevant design and criteria are already decided. An exploration subtask answers a question or produces findings needed for a decision. The Secretary applies the classification recorded by PM; a change of type is recorded with its reason and links to the previous work.

An experiment can be an execution subtask when its procedure and expected evidence are already specified. Interpreting its results to select an approach can be a separate exploration subtask. A failing implementation check ordinarily remains execution repair.

Exploration retains the existing evidence and review workflow. Its receipt specifies a question, constraints, experiment or investigation bounds, required evidence, stopping conditions and the decision owner. Accepted findings can be negative or inconclusive when they satisfy those conditions honestly. A downstream execution subtask that requires a design choice stays blocked until PM records that choice; accepting findings does not manufacture a decision.

Rerouting preserves the original outputs, failed attempts and lineage budget. A new linked exploration question cannot reset the repair budget of the execution subtask it supports.

## Roles and ownership

| Role | Responsibility |
|---|---|
| PM | Align with the user, interpret requirements, record design choices, publish the task graph and scheduling policy, authorise operational delegation and own mission outcomes |
| Secretary | Select eligible work, issue current receipts, apply approved coordination rules, route prerequisite work and repairs, maintain task state and prepare decision escalations |
| Architect | Inspect actual prerequisites, input availability, interfaces, environment compatibility and structural conflicts; record readiness or precise gaps |
| Constructor | Implement inside the admitted scope, capture changes and outputs, run required verification and provide a completion receipt |
| Acceptance seat | Independently check the actual integrated delivery against the receipt and criteria, then accept, request repair or identify a decision needed |
| Runtime | Enforce current authority, dependencies, scopes, budgets and evidence; publish durable ledger events and derived queue state |

The execution acceptance seat is the Stabilizer. A separate Crititor is conditional when the reviewed receipt requires an additional specialist review. The acceptance seat is independent of the Constructors and does not edit the product. The Architect's ordinary responsibility remains prerequisite readiness.

Formal counterexamples, scoped holds, independent contests and explicit latch release retain their existing recovery path. The Secretary can route and track that work; its scheduling powers cannot dismiss a case or waive a hold.

## Planning receipt

A planning receipt is the work order issued by the Secretary from a reviewed contract. It is separate from the Constructor's completion receipt.

| Field | Required meaning |
|---|---|
| Identity | Stable receipt id, version, parent task, subtask and lineage |
| Authority | Original requirement references, current delegation, applicable constraints and PM decision references |
| Policy | Explicit workflow policy and execution or exploration type |
| Contract | Intended result, criteria, expected outputs and applicable interface definitions |
| Prerequisites | Required accepted outputs or decisions, their versions and the actual environment conditions to inspect |
| Work scope | Exact write paths or isolated work locations, worker assignments and any integration owner |
| Verification | Complete definitions of checks, inputs, environment, predicates, evidence mappings and output destinations |
| Limits | Product or investigation budget, run limits, deadlines and the owner of unresolved decisions |
| Review basis | Current planning review and admission references |

Record the contract and all required verification definitions together before review and admission. Merely listing a future requirement id does not bind its definition. The runtime refuses admission with an unresolved required definition and records any later material definition change as a contract revision.

The receipt references immutable records and CAS evidence rather than carrying the whole mission history. Scheduling metadata is stored separately from the contract and readiness basis.

## Receipt lifecycle

| State | Entry condition | Responsible seat or runtime action |
|---|---|---|
| PLANNED | Subtask is present in the task graph; required decisions or review may still be outstanding | PM and derived graph view |
| ISSUED | Contract is reviewed, definitions are complete and a current receipt is issued for prerequisite inspection | Secretary under delegation |
| BLOCKED | Required evidence, prerequisite or current authority is unavailable | Runtime or Architect records the specific gap |
| READY | Architect has checked the actual prerequisites against this receipt; required accepted dependencies and authority are current | Architect readiness record and runtime qualification |
| RUNNING | Current readiness is rechecked and assigned workers claim the receipt | Runtime dispatch and Constructor claim |
| CONSTRUCTED | All assigned workers have recorded their outputs and required verification, including any declared integration work | Constructors and runtime |
| ACCEPTED | Independent acceptance covers the current integrated product, criteria and evidence, with no applicable unresolved hold | Acceptance seat and runtime |
| REPAIR_REQUIRED | Acceptance identifies a concrete defect within the approved contract and budget | Acceptance seat; Secretary routes repair |
| NEEDS_DECISION | A missing or conflicting decision prevents work or acceptance | Architect, Constructor or acceptance finding; Secretary escalates |
| SUPERSEDED | A material contract revision replaces this receipt | Recorded revision with predecessor and affected dependencies |
| DEFERRED or CANCELLED | A valid authority explicitly disposes the obligation with owner and reason | Authorised disposition; never presented as accepted delivery |

ACCEPTED unlocks only the dependencies whose required outputs and decisions it actually provides. CONSTRUCTED does not unlock them. An authorised gap does not satisfy an output prerequisite; a changed dependency or alternative producer needs an authorised graph revision.

A state view exposes both recorded milestones and current qualification. A historic acceptance can remain in the ledger while its current qualification is STALE, BLOCKED or INPUT_INCOMPLETE. The Secretary schedules from qualified state, not from the presence of a PASS or ACCEPTED record alone.

State inspection remains read-only. It returns the relevant basis and reasons when qualification is unavailable; it does not create cases, expire jobs or change the queue as a side effect of a PM read.

## Architect prerequisite check

The Architect reads the current receipt and the actual code, delivery and environment evidence. It checks required interfaces and schemas, services and tools, inputs, accepted dependency outputs, declared paths and structural conflicts between assigned workers. It reports READY or a precise blocker with the relevant evidence and affected subtasks.

Absence of an interface blocks work when the receipt requires it as an input. An interface explicitly assigned as an output is expected construction work. The Architect does not choose a new interface design in its readiness verdict.

The readiness record binds the receipt contract, accepted prerequisite versions and inspected environment basis. The runtime rechecks that basis before dispatch. Relevant changes require a refreshed check; unrelated queue progress does not invalidate readiness.

Preflight includes verification output mappings, available interpreters and declared executor limits. Missing future outputs of unrelated subtasks cannot hold this receipt's readiness or evidence bundle hostage.

## Construction and parallel integration

Constructors receive their scoped receipt, applicable original requirements, design decisions, relevant product inputs and the evidence needed for their assigned checks. Default packets and tool responses are compact; full sources remain available through explicit reads.

Parallel workers have disjoint write scopes or isolated work locations. Shared writes require a declared sequential integration owner. The Architect identifies structural conflicts and the Secretary schedules according to the approved graph. The runtime preserves current file hashes and refuses stale writes.

Each worker records its actual changes, output hashes, run ids and results. One Constructor owns integration when the receipt requires it. CONSTRUCTED requires the integrated candidate and all assigned worker outputs to be available; acceptance inspects that candidate.

The completion receipt maps every criterion to actual evidence or an explicit gap. Automatically known metadata comes from runtime records. The Constructor adds explanations, unresolved defects and concrete decision questions. Local failed checks remain run evidence and do not each require a full narrative report or a separate PM handoff.

## Execution acceptance contract

One independent acceptance record covers the current receipt or declared batch after all its Constructors finish. It reads the actual delivered bytes and relevant source evidence. Required specialist checks can be separate, but are declared in the reviewed contract or justified by a concrete finding.

Acceptance requires all of the following:

1. The receipt, authority, admission, prerequisites and applicable contract definitions are current.
2. Every required worker output and the integrated result match the recorded candidate.
3. Every criterion has sufficient evidence and is actually satisfied. Verification coverage includes the agreed behavior, applicable interface contracts and cross-worker seams.
4. Required runs completed with satisfied predicates against the current inputs, environment and outputs. A completed process alone is insufficient.
5. Findings are resolved or explicitly routed without disguising an unmet criterion as met. Applicable cases and latches remain enforced.
6. The acceptance seat is independent of the Constructors.

The decision is ACCEPTED, REPAIR_REQUIRED, NEEDS_DECISION or INPUT_INCOMPLETE, with precise criterion and evidence references. PM and Secretary do not issue a product acceptance on behalf of the reviewer.

After a concrete repair, the next completion receipt records the changes and updated evidence. The reviewer checks the repair and all behavior it affects. Unchanged qualified evidence can remain usable. Deterministic verification can be reused only when its full input, environment, output and acceptance semantics permit; independently sampled experiments remain distinct observations.

Use the existing three product cycles per lineage as the initial execution budget: one initial candidate and at most two substantive repair candidates. Narrative or scheduling corrections do not spend a product cycle. Internal runs retain explicit run and deadline limits. Exhaustion produces an explicit blocked or authorised disposition path, and never unlocks an unmet dependency.

## Secretary delegation

Operational delegation names the authorising PM decision, applicable principal grant, permitted graph operations, scope, budget and scheduling rules. The runtime checks it on each change. The Secretary cannot gain PM authority by submitting with a PM role label.

| Operation | Secretary may proceed when | PM escalation condition |
|---|---|---|
| Refresh status or unlock dependencies | Current evidence and acceptance establish the transition | Evidence is ambiguous or authority conflicts |
| Select or reorder ready work | PM's scheduling policy permits it | A material priority commitment or tradeoff changes |
| Schedule a missing prerequisite | An approved definition or blueprint fixes its behavior, criteria, scope and budget | Interface behavior, architecture, criteria or material scope must be chosen |
| Correct receipt references | The correction preserves the approved meaning and is recorded with its basis | The input, output or required behavior changes |
| Route an implementation repair | The finding is concrete, inside the current contract and budget, with no prohibited hold | The design must change or budget is exhausted |
| Route a known exploration step | It is already authorised by the plan or a recorded contingency | A new material investigation or design choice is required |

The Secretary arranges construction work; it does not implement fixes or judge product quality. In 3.0.0, prerequisite producers are predefined by PM and independently reviewed. Generating a new task from a blueprint requires PM to define its immutable contract and obtain scoped review/admission. Secretary cannot expand write permissions, alter criteria or reset a budget.

For a missing interface whose producer and dependency are already defined by PM, the Secretary selects the authorised producer and routes it through readiness and construction. New graph edges require PM and scoped review. For an undefined interface, Secretary sends PM a decision packet with the gap, affected criteria and subtasks, options, recommendation and original evidence references.

Important design decisions and user-facing tradeoffs remain with PM and the user. PM acts within its recorded delegation and communicates material choices; reserved goals or constraints require the principal's authority. The Secretary records its actions before publishing the refreshed task view.

## PM context and ledger access

The Secretary reduces routine material pushed into PM's active context. PM retains complete business-ledger access, including original reports, actual evidence, secretary actions and acceptance history, and can inspect them on demand.

Automatic PM updates contain decision escalations, material operational failures and compact milestone or task-state references. Routine raw logs are available behind their immutable references. The Secretary's summary never replaces original authority or source evidence and cannot suppress a formal finding.

Ordinary status transitions and dependency calculations are runtime operations. Invoke the Secretary when interpretation or an authorised coordination action is needed. Its role should not add a full-history agent turn to every event.

## Traceability and scoped freshness

Keep original authority, PM choices, graph revisions, receipts, readiness, actor identities, product changes, all attempted runs, findings, acceptance and dispositions in the authoritative journal and CAS. Compact responses return ids, outcomes and evidence references. Source reports are stored once, and repeated role reads request the relevant current records.

Formal issues have stable case identities across receipt and repair revisions. Ordinary repair findings remain anchored to immutable acceptance ids and their linked repair routes; completion gaps and coordination observations remain separate records. A mandatory counterexample keeps its scoped barrier.

The contract digest includes full verification definitions. Readiness binds relevant prerequisites and environment. Acceptance binds the integrated product, criteria, relevant authority, runs and dependencies. Queue metadata is outside these bases. A changed basis stales the affected work and its dependents; unaffected siblings retain their qualification.

Task or batch bundles contain the required scope and dependency closure. Complete mission evidence remains available for final closure. Missing evidence in a judged scope is explicit INPUT_INCOMPLETE, and cannot become READY or ACCEPTED.

## Existing runtime and pull requests

The 2.1.0 runtime froze task ids and their fields at review/admission, required separate development, Crititor and Stabilizer reports, and used broad mission evidence and freshness checks. Version 3.0.0 adds nested subtasks, qualified queue state, delegated Secretary actions, atomic contracts and one independent execution acceptance.

[PR 6](https://github.com/ZhuoQiuMcgill/mission-pipeline/pull/6), reviewed at `52f2067592510e4a9cea921344f3223c154208b5`, addresses six field defects: obligation disposition preservation, missing delivery snapshots, decision-domain mismatch, write-limit visibility, query state and requirement-id duplication. These are useful base repairs. Its derived admission/acceptance view is a record-state view; it does not certify current product, execution, dependency or hold qualification for dispatch. The new queue needs that distinction explicitly.

[PR 5](https://github.com/ZhuoQiuMcgill/mission-pipeline/pull/5), reviewed at `7fc8905a5b19e44ac76bebbed7c2642db942fa63`, fixes released legacy mission-close payloads and tolerates whole historical transactions that replay rejects. Any rejected historical transaction must remain disclosed history and must be excluded from qualified imported contracts, findings and acceptance credits.

Select the policy explicitly for new work. Historical records retain the policy and assurance under which they were produced. Mode changes create a recorded boundary and preserve lineage budgets; they do not reinterpret old acceptance or remove active holds. Preserve the honest local-execution assurance label.

## Implementation checks

The following behaviors define the first implementation's acceptance scope:

- A mixed parent task schedules execution and exploration with explicit output and decision dependencies; only accepted, current prerequisites unlock downstream work.
- An already defined missing interface can be scheduled by the Secretary within delegation. Choosing an undefined interface escalates to PM.
- Parallel work produces one integrated candidate for acceptance, with collisions refused and missing worker outputs preventing acceptance.
- A stale environment, changed prerequisite or changed product invalidates the affected readiness or acceptance; an unrelated queue update preserves it.
- Required verification definitions exist before review/admission. A late definition cannot run under a review that never bound it.
- A changed execution report exposes a focused repair record without losing the previous evidence or resetting the cycle budget.
- Rejected legacy replay transactions cannot create current acceptance credits or governing contracts.
- Secretary actions remain inspectable by PM, and budget or authority limits are enforced by the runtime.

The implementation combines base runtime repairs, atomic subtask contracts and qualified state, scoped readiness/dispatch/acceptance, and delegated Secretary coordination with compact default evidence responses. Exploration and final mission-closure checks remain shared.
