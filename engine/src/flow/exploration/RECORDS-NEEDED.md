# Ledger records the exploration and legalization flows need

The exploration flow (`src/flow/exploration/`) and the legalization flow (`src/flow/audit/`) write only record kinds that exist in `src/common/records.ts`, plus the `flow.event` kind the decision-layer flow already proposes (`src/flow/ports.ts`, `FlowEventRecord`). This file lists what they write, and the three changes they need from the ledger side.

## What the flows write today

| Record | Written by | Shape (existing kind) |
|---|---|---|
| Exploration definition | `defineExploration` | `basis.version`, `basisKind: 'standard'`, line `xpdef.<mission>.<x>`, versions `xpdef.<mission>.<x>.v<n>` (a changed definition is a new version), `mission`, `scope: null`. It is the basis line of every attack judgment's contract (10.1 "Crititor 攻击与裁决": the exploration definition's version, with the user's acceptance goal verbatim). The definition document itself is in the content store and in the `defined` flow event. |
| Evidence environment | `defineExploration` | `env.snapshot`, line `xpenv.<mission>.<x>`, snapshot `xpenv.<mission>.<x>.<hash16>`. Evidence executions of the exploration bind it (7.2: applicable while it is current). |
| Product version | the author or interpreter card's `records()` (host, pending result) | `object.version`, `objectKind: 'interpretation'`, id `xpv.<mission>.<x>.<n>.<hash16>`, `prerequisites` = [the method version] for a research interpretation, `scope: { paths: ['exploration/<x>'], taskType: 'exploration' }`, `reviews: [{ review: 'crititor', basisLines: ['xpdef.<mission>.<x>'], reliesOn: [method version or none] }]`, `predecessor` = the previous version. |
| Attack round | the Crititor card's `records()` | `judgment`, `review: 'crititor'`, `executor: 'crititor'`, verdict from `attackOutcome` (pass / fail / undecided), `evidence` = the runs the version's standing rests on (rebuttals of resolved findings; a research answer's cited records) plus what the round cited (review r1 #2), `bases` = [definition version], `issues` = its re-checks (fixed / not-fixed), `revokes` = the version's standing negation when it passes. |
| Finding | the Crititor card's `records()` | `issue`, id `finding:<doc hash>`, `observedOn: [version]`, `text` = the finding document (`mp4.exploration-finding.v1`). |
| Evidence execution | a reading: its card's `records()` (the host's fetched pages check `fetch:<k>`); an experiment: the flow, from the launch's `run.layer` records (review r1 #20); the flow for failed, given-up or unreadable runs | `evidence`, id `xpe.<mission>.<x>.<k>`, `runClass: 'open'`, `fields`: `status` (`completed` only when every claim cites a record the program holds, else `unverified`), `executor`, `attempt` (research), `step:<i>`, `measure:<name>` (cut at 200 chars), `assertion:<i>`, `run:<k>` / `fetch:<k>` (the records), `report`, or `reason` for a program-generated record (8.2). |
| Node backfill | the `auditor-node` card's `records()` | `judgment`, `executor: 'auditor'`, one per position filled, `revokes: null` always (5.2), bound by the position's contract (current basis versions, `reliesOn`, the object constraints with their required paths as `ConstraintCheck`s). |
| Chain-acceptance object | `advanceLegalization` | `object.version`, `objectKind: 'chain-acceptance'`, id `chain.<mission>.<L>`, `reviews: [{ review: 'auditor-chain', basisLines: [requirement-set line], reliesOn: <every node of the chain> }]`. |
| Chain judgment | the `auditor-chain` card's `records()` | `judgment`, `review: 'auditor-chain'`, `executor: 'auditor'`, evidence = the chain evidence it cited. |
| Stamp | `advanceLegalization` | `op.pending` (`opKind: 'legalization'`, objects `[chain.<mission>.<L>]`), then `op.executed` through `commitProofOp` with the result event (see 1). |
| Flow state | both flows | `flow.event` on lines `exploration:<x>` (events `defined`, `queued`, `consumed`, `ruling`, `stopped`, `settled`) and `audit:<L>` (`requested`, `planned`, `started`, `queued`, `consumed`, `chain`, `op`, `result`). Bodies are JSON documents; their types are in `machine.ts` and `audit/flow.ts`. |

## Changes needed

### 1. The stamp's execution goes through `commitProofOp` (done, review r1 #5)

The audit flow calls `FlowLedgerPort.commitProofOp({ op, opId, asOf, events: [result] })`: the execution and the legalization's result event are one transaction, and the PM is told only after it (the notice is sent again, idempotently, on the next pass after a crash). The request op names the attempt (`…:stamp:<opId>:<asOf>`), so a retry at a newer revision is a new request; the ledger refuses a second execution (FACT_CONFLICT). Refusals: BELOW_FLOOR / NOT_READY / UNAVAILABLE → wait for the next pass; STOPPED → wait while the stop holds (nothing stamped); NOT_PENDING / EVALUATOR_FAULT → a new operation is registered (`legal.<mission>.<L>.r<k>`, WI-11).

### 2. Reference edges (optional; 11.1 partial legalization)

11.1 says a branch reached only through reference edges is excluded and the stamp names it. No record holds reference edges (5.3: "参考边不进计算图，只在第 2 层留注记"), so the plan's `excluded` list is always empty. Proposed bookkeeping kind (not an evaluator input):

```ts
export interface ReferenceEdgeRecord {
  readonly kind: 'edge.reference';
  readonly from: ObjectVersionId | ProofUnitId;
  readonly to: ObjectVersionId | ProofUnitId;
  /** Why the reference is not a prerequisite (content store). */
  readonly note: ContentHash;
}
```

### 3. A basis kind for the exploration definition (optional)

The definition is recorded as `basisKind: 'standard'`, which the evaluator already treats correctly (a basis valid while it is the latest version of its line). A dedicated `'exploration-definition'` kind would make layer-2 listings clearer; nothing else changes.

### 4. The WI catalog (required for the proposed WI)

`src/common/validate.ts` refuses an `alert` whose `wi` is outside `WI_CATALOG` (WI-01 to WI-22). The legalization flow's notices name the proposed WI-25 (`WI-NEEDED.md`); the decision-layer flow's name WI-23, WI-24 and WI-26, and the seat host's WI-27. Once accepted, `WI_CATALOG` (records.ts), `isWi` (src/cli/wi.ts) and `plugin/pm/wi/` need the new pages; until then the ledger refuses those alerts (the control-plane copy still reaches the PM's monitor).
