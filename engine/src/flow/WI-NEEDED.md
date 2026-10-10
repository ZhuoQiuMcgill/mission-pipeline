# Proposed work instructions for the decision-layer and execution flows (design 3.11)

These are the exceptions the decision-layer and execution flows (`src/flow/planning.ts`, `execution.ts`, `secretary.ts`, `failures.ts`) can emit that have no WI in 3.11 yet. Their numbers are allocated with the coordinator:

- this file: WI-23, WI-24 and WI-26;
- the exploration/audit agent's file (`src/flow/exploration/WI-NEEDED.md`): WI-25, and WI-28 onwards;
- the host's "web fetch refused": WI-27.

Each page is written for the PM, in the format of 3.11 principle 2. The program's notice carries the WI number, the trigger facts and the default action already taken (`src/flow/wi.ts` maps each exception to its WI).

All other exceptions of these flows use existing WIs:

| Exception | WI |
|---|---|
| A loop is exhausted or shows no progress: mechanical returns, feasibility returns, reworks, environment retries, restarts | WI-08 |
| A seat failed, was quarantined, or overflowed its resources (the scheduler's notice; the flow escalates to the Secretary) | WI-15 |
| A program defect inside a flow (an accepted hand-back without its records or export; an unexpected error) | WI-20 |

Normal branches are notices without a WI (`informational`):

- a Calibrator ① return to the PM;
- a Secretary decision taken within authority;
- a decision that needs the user (3.2).

Rows to add to the exit table:

| Exit (cause) | Clause | WI |
|---|---|---|
| A re-plan drops or changes a task while one of its seats is running | 3.4, 3.10, 4.2 | WI-23 |
| The Secretary seat ends without a decision | 3.8 | WI-24 |
| A decision-layer step cannot continue as it is (its seat was cancelled by a stop) | 3.3–3.7, 6.4 | WI-26 |

---

**WI-23 A re-plan dropped or changed a task that has work in flight**

- **Trigger.**
  - A new detailed plan took effect (after Calibrator ②, or after a Secretary or user ruling) while a Constructor or Reviewer of one of its tasks was running.
  - The new plan either drops that task or changes its card (goal, standards, write scope, commands).
  - The program finds this when it applies the new plan: the task's line has a dispatched attempt whose seat is still running.
  - Evidence: the task, the attempt, the running launches, the old and new plan versions.
- **Default action.**
  - The running seats finish. Their results are recorded but not continued under the old card.
  - Queued attempts of the old card are cancelled.
  - A changed task starts its next attempt with the new card, in the same lineage, so its loop counts go on.
  - A dropped task stops and keeps its products: nothing is deleted.
  - The rest of the mission goes on.
- **Options and outcomes.**
  1. Let it be (the default). The finished attempt's product stays in the ledger as an unaccepted or old-card version, and it is not delivered.
  2. The dropped work was worth keeping: ask the Architect to re-plan with it (via the Secretary's "re-plan" on a related task, or a new PM batch saying so). The task comes back with a card that matches the work already done; its next attempt reworks from it.
  3. The change was a mistake: record a new PM batch that restores the old element. The decision layer re-plans, and the task's card goes back to what it was, at the next attempt.
- **How to choose.**
  - The task was dropped on purpose (the user changed scope) → 1.
  - Expensive work in flight that the new plan could have used → 2.
  - The re-plan misread the user → 3.
- **When to ask the user.** Only when the drop changes what the user gets (3.2 kind 1). Then it is a scope change, and the user should already have seen it at Calibrator ①.

**WI-24 The Secretary could not decide**

- **Trigger.**
  - The one-shot Secretary started for an escalation ended without a usable decision: its seat failed, it was quarantined, its environment retries ran out, or its task was cancelled.
  - The program finds this when it reads the Secretary task's state.
  - Evidence: the escalation (source, subject, options), the Secretary task's state and note.
- **Default action.**
  - The decision goes to the PM and the user. Only the escalated item waits (one plan step or one task); the rest of the mission goes on.
  - No second Secretary is started automatically, because a second one could fail the same way. The PM decides directly.
- **Options and outcomes.** The PM records the decision with the user using the flow's `answerEscalation` (CLI: `mp answer <escalation> --option <option> [--instructions ...] [--extra n] --words "<user's words>"`).
  - The options are the escalation's own: accept, accept-risk, send-back, re-plan, grant, restart, abandon, answer, rework.
  - The program carries the answer out exactly as it would have carried out the Secretary's.
  - Accepting a negated review position records the user's ruling as a pass that revokes the negation (8.1).
- **How to choose.**
  - The PM can decide within a recorded authorization (a detail, or important and authorized) → decide and tell the user in one line.
  - It is one of the 3.2 kinds → ask the user.
- **When to ask the user.** For 3.2 decisions; and when the Secretary fails repeatedly, which may be an environment problem (see WI-15 and WI-18).

**WI-26 A decision-layer step cannot continue as it is**

- **Trigger.**
  - A decision-layer seat's attempt ended in a state the program must not repair by itself. Calibrator ①, Architect (decomposition or feasibility) and Calibrator ② are the affected seats; the typical case is a result quarantined because of a stop (6.4: never restarted while the stop holds; 6.2).
  - The step has no other option: no abandon, and no re-plan of the plan itself.
  - The program finds this when it reads the task's state.
  - Evidence: the task, its disposition and note, the stop.
- **Default action.** Only this plan step waits. The rest of the mission (tasks of an earlier effective plan, explorations) goes on, within the stop's scope. Nothing restarts automatically.
- **Options and outcomes.**
  1. The stop was meant (the user stopped this work): leave it. The plan stays where it is until the user wants to continue.
  2. The stop is released and the work should go on: record a new PM batch (the same plan is fine). The decision layer runs again from Calibrator ① for that batch. Already accepted work is not redone, and loop counts are kept per PM plan version.
  3. The stop is still active but too wide: narrow it with the user (6.4 "再收窄"), then option 2.
- **How to choose.**
  - The user said stop → 1 until the user says otherwise.
  - A stop that was too wide (for example "stop the network" also caught this seat) → 3.
- **When to ask the user.** Always before resuming work the user stopped (the stop is the user's).
