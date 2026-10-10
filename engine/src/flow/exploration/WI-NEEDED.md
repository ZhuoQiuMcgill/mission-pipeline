# Work instructions the exploration and legalization flows need

Every exception these flows raise names a WI (design 3.11, principle 5). Most map onto existing pages; one is new (WI-25), and WI-08 and WI-15 need an exploration section. Allocation (coordinator, 2026-10-09): WI-23, WI-24 and WI-26 are the decision-layer flow's, WI-25 is this flow's (legalization), WI-27 is reserved for the seat host (web fetch refused); any further WI starts at WI-28. These flows need none beyond WI-25.

## Exits and their WI

| Exit | Where | WI |
|---|---|---|
| Exploration round budget used without converging | `machine.ts` decide, `flow.ts` stop | WI-08 (+ exploration section below) |
| The same class of fatal finding not fixed in two consecutive rounds (8.2 stop 3) | same | WI-08 (+ section) |
| No progress: the same unresolved fatal or serious findings two rounds in a row, nothing new (6.5) | same | WI-08 (+ section) |
| An author, attacker or interpreter task given up after its failure | same | WI-15 (+ retry, below) |
| A seat turn asked for more evidence runs than the definition's per-turn cap (default 3): the request is recorded as not run and the seat resumes | `flow.ts` evidence | WI-08 (+ section) |
| A seat asked for evidence but no session id was kept: a new session from the ledger material | `flow.ts` resume | WI-17 |
| An evidence run failed, was given up, or its request could not be read: the program records it as failed / not run and the requester goes on | `flow.ts` | none: a normal branch (8.2 "失败、中断、未执行的记录由程序自动生成") |
| Converged; a direction question; a ruling awaited | `flow.ts`, `step.ts` | none: normal branches (the Secretary and 3.2 decide) |
| Legalization refused at the plan (a negated or withdrawn node on a required path) | `audit/flow.ts` | **WI-25** (new) |
| A node backfill did not prove its node; a node became negated meanwhile; nodes wait on each other | `audit/flow.ts` | **WI-25** |
| The chain Auditor did not pass, or the chain object is not proven although it passed | `audit/flow.ts` | **WI-25** |
| A node Auditor given up | `audit/flow.ts` | **WI-25** (the scheduler raised WI-15 for the failure itself) |

## WI-08: section to add for explorations

### Explorations (8.2 stops 2 and 3, 6.5 no progress)

**Trigger and evidence.** An exploration stopped without converging: its round budget is used, a fatal finding of the same class was not fixed in two consecutive rounds, or two consecutive rounds ended with the same unresolved fatal or serious findings and nothing new. Evidence: the hand-off document named in the notice (the current version, every finding with its disposition and re-checks, the unresolved ones, the evidence executions).

**Default action already taken.** No further round is queued for this exploration; nothing else stops. The program raised an escalation to the Secretary (source `exploration-budget` or `exploration-repeated-fatal`).

**Options and outcomes** (the Secretary picks one; the user when the Secretary asks, `mp` answer to the escalation):
1. `grant` 1 or 2 more rounds → the exploration continues where it stopped. The grant goes through the ledger's rule: the Secretary grants once per lineage (across all its loops); a further Secretary grant is refused and the escalation goes to the user, whose answer then applies.
2. `accept-risk` → the current version is accepted with its unresolved findings as residual risks: the ruling revokes the version's negation (8.1) and the exploration settles as a conclusion; the risks are listed for the user.
3. `send-back` with instructions → the unresolved findings go back to the author with the new direction, within the rounds left (sending back adds no rounds; it is offered only while some are left).
4. `replan` → the exploration settles as "no conclusion" and the decision layer plans again (a direction decision: the user is asked, 3.10).
5. `abandon` → the same, and the exploration is closed.

**Evidence cap.** A seat asked for more evidence runs in one turn than the exploration allows (`evidencePerTurn`, default 3). The default action already taken: the request is recorded as not run, the seat resumes with that answer and must hand back; its next turn may ask again. Options: none needed when the seat then hands back; if a turn genuinely needs more runs, the decision layer defines the exploration again with a larger cap.

**How to choose.** Budget used but findings shrinking round by round → 1. The same fatal class keeps coming back, or no progress → 3 or 4, not 1: more rounds of the same approach rarely help. The remaining findings are real but acceptable to the user → 2.

**When to ask the user.** When the grant was already used, when the remaining risk touches what the user gets or cannot easily be undone (3.2), and always for 4.

## WI-15: addition for explorations

When the task given up was an exploration's author, attacker or interpreter, the exploration stops at that turn. To go on, the PM records an exploration ruling `retry` (it queues the same turn again, as a new task in the same lineage); to end it, a ruling `stop`. There is no `mp` command for exploration rulings yet: state the choice in the session (`recordExplorationRuling` in `src/flow/exploration/flow.ts`).

## WI-25 (new page)

```markdown
# WI-25 A legalization cannot complete: a broken link, a failed backfill, or a chain not accepted

## Trigger and evidence
- At the plan: the endpoint rests, through required edges only, on a node that is negated or whose basis is withdrawn. No Auditor can prove such a node (an Auditor never revokes a negation, 5.2), so the endpoint cannot be legalized (11.1). Evidence: each such node, its label and the required path from the endpoint.
- During the audit: a node Auditor's judgment did not prove its node (it failed or was undecided), a node of the chain became negated or withdrawn meanwhile, or the remaining nodes wait on each other (a cycle without a proof unit, WI-16).
- At the end: the chain Auditor did not pass (the user's words not honoured, a seam that does not hold), or the chain object is not proven although its judgment passed (its evidence no longer applies).
The notice names the legalization, the outcome and the nodes.

## Default action already taken
No further Auditor is started and nothing is stamped. Judgments already made stay recorded and keep counting for the nodes they proved. Nothing else in the mission stops.

## Options and outcomes
1. Fix the broken node: the work that produced it is reworked and judged again by the same kind of review (only that can revoke its negation, 8.1); then ask for a new legalization → a new plan, a new chain object.
2. Legalize a different endpoint: one whose required lineage avoids the broken node (for example an earlier version) → a new legalization of that endpoint.
3. Chain not accepted: read the chain Auditor's findings (issue records on the chain object); fix what they name, then ask for a new legalization (a chain object judged negative is never revived; the next one is new).
4. Leave it: the endpoint stays not fully proven; delivery and closing show it in the risk list.

## How to choose
A negated node that is still needed → 1. The negated node is obsolete → 2. A seam or a quote the chain Auditor rejected → 3. The user only wanted to know whether it could be legalized → 4.

## When to ask the user
Always: legalization is work the user asked for, and the result goes to the user (11.1). Say which node or seam blocks it and what each option costs.

The safety floor is never an option: stops stay in force; nothing unproven is called proven; no repository hooks or forced rewrites in the user's worktrees; no deletion of the user's data.
```

INDEX line: `- WI-25: A legalization cannot complete: a broken link, a failed backfill, or the chain not accepted`
