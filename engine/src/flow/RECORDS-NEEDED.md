# Ledger records the flows need (owner: the ledger agent)

The decision-layer, execution, exploration and audit flows (`src/flow/**`) keep no state of their own. Everything they decide is a ledger fact. Most of these facts are existing kinds. This file lists what is missing, and how the flows use the kinds that already exist.

**Status (2026-10-09): delivered by the ledger agent.**

- **Delivered:**
  - `flow.event`;
  - `seat.result.sessionId`;
  - the indexed queries `flowEvents`, `flowMissions`, `recordsByKind`, `objectVersion`, `judgmentById`;
  - `commitProofOp` with `events`.
- **Adapter:** `src/flow/adapters.ts` uses them (paged, with no whole-ledger scans), and `test/flow-adapters.test.ts` checks them against the real ledger service.
- **Still open:** reading `basis.version` for one mission plus the project-wide versions (`mission: null`). The flows read every mission's basis versions by kind instead.

The sections below are kept as the specification.

## 1. `flow.event` (new base record kind) — required

One fact of a flow line: a PM batch, a consumed seat result, a mechanical-check result, an escalation and its decision, an Architect attempt, an effective plan, a rework, an accepted task, an exploration round, and so on. The body is typed by the flow module that owns the line (`src/flow/plandoc.ts`, `planning.ts`, `execution.ts`, `secretary.ts`, `exploration/**`, `audit/**`).

```ts
interface FlowEventRecord {
  readonly kind: 'flow.event';
  readonly mission: MissionId;   // id()
  readonly line: string;         // 1..200 printable chars, e.g. "plan", "task:impl", "secretary", "exploration:x1", "audit:..."
  readonly event: string;        // 1..64 chars, [a-z0-9-]
  readonly key: string;          // 1..200 printable chars
  readonly body: ContentHash;    // canonical JSON document in the content store
}
```

- **Identity.** `(mission, line, event, key)` is unique.
  - The same identity with the same `body` in a later op is a no-op: it is not appended again, and the op still succeeds.
  - The same identity with another `body` is `FACT_CONFLICT`.
  - Op idempotency is as for every `appendRecords` op (same op and payload: the stored receipt).
- **Atomicity.** Flow events travel in `appendRecords` together with the base records they belong to, in one op and one transaction. Examples: a PM batch with its PM plan `object.version`; an effective plan with its standards' `basis.version` records; the user's answer with its ruling `judgment`.
- **Validation.** The fields as above; `body` must be in the content store (the same blob check as `alert.body`, `verifier.requireBlob`).
- **Bookkeeping.**
  - It is not in `EVALUATOR_INPUT_KINDS`; the evaluator never sees it.
  - It must be added to `APPEND_KINDS`.
  - It is never a pending result: seats never write flow events.
- **Projection.** A table `flow_events(mission, line, event, key, body, revision)`, primary key `(mission, line, event, key)`, with an index on `(mission, line, event, revision)`. It is rebuilt from the log like every state table (10.1 rule 3).
- **Queries** (IPC, read-only):
  - `flowEvents({ mission, line?, event?, after? }) → Array<{ revision, mission, line, event, key, body }>` in revision order. The adapter currently scans `readRecordsAfter(0)` instead, which is O(ledger) per call; this query replaces the scan.
  - `flowMissions() → MissionId[]`: missions that have flow events.
- **Retention.** Flow events are never collected while their mission is open. Their bodies are small: ids, verdict summaries, finding lines.

## 2. `seat.result.sessionId?: string | null` — required for async evidence (6.2)

The session to resume after a "needs evidence" hand-back. Today it is only in the host's `outcome.json` under the state directory, and the adapter reads it from there. Put it on the record, because the state directory is not the ledger and a restarted machine may not have it. Validation: `id()`-like, or null. `PENDING_KINDS` is unchanged.

## 3. Indexed reads (performance, not correctness)

The adapter reads committed base records by kind with a full scan (`readRecordsAfter(0)`). The flows read `basis.version`, `basis.withdrawn`, `object.version`, `judgment`, `issue` and `user.words`. Proposed query: `recordsByKind({ kinds, after? })`, plus `objectVersion({ object })` and `judgmentById({ judgment })` lookups. Until these exist, cost grows with the ledger. That is fine for the first missions, but it is not fine at 100,000 records (5.5).

## 4. Existing kinds the flows use, and how

The task statement's "missing kinds" mostly map onto existing records:

| Fact | Kind | Shape the flows write |
|---|---|---|
| Requirement item version (3.1) | `basis.version` | line `<mission>.<item>`; version `<line>.v<n>`; basisKind `requirement` (goal, limit, decision), `authorization`, or `standard` (acceptance). Text, provenance and the restatement/confirmation pair go in a `flow.event` (`requirements` line, event `item`) |
| Requirement set (v31) | `basis.version` basisKind `requirement-set` | line `reqset.<mission>`; a new version on every item change, with a snapshot of the item versions in force; an empty one at the first PM batch |
| Withdrawn item | `basis.withdrawn` | plus a new requirement-set version |
| Project constraint (9.5) | `basis.version` basisKind `constraint` or `instruction`, with its scope | text in a `flow.event` (`requirements` line, event `constraint`) |
| PM plan version (3.3) | `object.version` objectKind `plan` | object `pmplan.<mission>.<n>`; scope `plans/pm-plan.json`, taskType `pm-plan`; reviews `[calibrator-1: requirement set + cited authorizations]`; `predecessor` set |
| Detailed plan version (3.4) | `object.version` objectKind `plan` | object `dplan.<mission>.<n>.<k>`; scope `plans/detailed-plan.json`, taskType `detailed-plan`; reviews `calibrator-2` (relies on the PM plan), plus `feasibility` when 3.6's rule says so. Written by the Architect launch as a pending result (registry `records()`) |
| Acceptance standards of plan tasks | `basis.version` basisKind `standard` | line `std.<mission>.<task>.<standard>`; version suffixed with the text hash; written when the plan takes effect |
| Calibrator ①/② verdicts | `judgment` | review `calibrator-1` / `calibrator-2`, executor `calibrator`; pass, fail (negation) or undecided; continuation judgments carry `extends` |
| Feasibility verdict | `judgment` | review `feasibility`, executor `architect-feasibility` |
| Secretary or user ruling on a negated position | `judgment` | same review as the negation, executor `secretary` or `user`, verdict pass, `revokes` = the negation (8.1 "争议裁决"); same contract inputs as the negation |
| Secretary decision, user answer, escalation | `flow.event` (`secretary` line: `escalation`, `decision`, `to-user`, `user-answer`, `applied`) | |
| Product version | `object.version` objectKind `product` | recorded by the program from the export (adapter action `product`, pending) with the reviewer contract (standards and items, relying on the detailed plan) and the dependencies' accepted products as prerequisites |
| Reviewer verdict, findings | `judgment`, `issue` | already built by the host |
| Loop counts and grants (6.5) | `loop.attempt`, `loop.grant` | lineages `plan.<mission>.<n>` (decision layer) and `task.<mission>.<task>` (execution); loops `mechanical-return`, `feasibility-return`, `rework` (plus the scheduler's `env-retry` and `quarantine-restart`) |
| Notices to the PM | `alert` | WI or `informational: true` (the scheduler's Alerts) |

Exploration rounds, findings and legalization stamps are the exploration/audit agent's. Its flows use `flow.event`, `object.version`, `judgment`, `op.pending` and `op.executed` in the same way; see their files.

## 5. Pending-result kinds

Every record my card kinds' `records()` produce is already in `PENDING_KINDS`:

- `judgment`: calibrator-1, calibrator-2, feasibility, and the Secretary's ruling;
- `object.version`: the detailed plan.
