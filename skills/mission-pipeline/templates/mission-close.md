<!-- mp:header
mission: <Mission>
category: MissionClose
key: <Mission>
round: 0
version: <NN — 1 at the first close; a repudiation reopens the mission and the next close is v02>
derives-from: artifact:<final IntegrationNote id>[, artifact:<ClosureAudit id>]
-->
<!-- Seal with one call: python3 <skill>/scripts/mp seal <this file>. SEALING IT CLOSES THE
     MISSION — the note IS the close, exactly as sealing Charter v1 was the claim. There is
     no close verb for anyone to type.
     The seal REFUSES, naming the condition, while: any flag is undisposed · THIS mission's
     lint has findings (the seal lints this mission, not the whole deployment) · the closing
     run is missing or no longer matches the tree it judged · the closure audit is on and no
     ClosureAudit is cited · the section this deployment's closure mode requires is missing.
     A refusal is work still owed: do it and seal again — never route around one. -->
# Mission Close — <Mission>

- **Role:** PM · **Date:** <YYYY-MM-DD> · **Version:** v<NN>
- **Closure mode:** sign-off / auto <!-- PROJECT.md's declaration by the principal; the PM reads it, never chooses it (invariant 9) -->

## Closing run
<!-- The full-scope gate PROJECT.md names, executed over the INTEGRATED result and recorded
     `mp run record … --scope closing --result pass` — invariant 10: task-level verification
     may be narrowed for speed, this may not. The row must still bind the tree it judged; if
     the tree has moved since, re-run and re-record rather than re-word this line. -->
- `run:<id>` — `<the gate command(s)>` · result: <verbatim summary: counts, failures, skips> · log: `<path>`

## Closure audit
<!-- Required while the closure audit is on (`mp config set audit on`). The Auditor's sealed
     report, cited BY ID and never summarized here; its verdict is advisory and closes
     nothing. In auto mode this arms-length read is what stands in for the principal's
     presence at the close. Audit off → write the "not enabled" line and nothing else. -->
- `artifact:<id>` — DELIVERS / DELIVERS WITH GAPS / DOES NOT DELIVER · `<ClosureAudit file>` / not enabled.

## Principal's acceptance
<!-- SIGN-OFF MODE: required, and verbatim. The principal received the outcome, the flag
     ledger, the gate output, the Closure Audit and the repudiation list (`mp acts
     --mission`), tried the result, and accepted in their own words. Quote them — a PM
     compilation is not an acceptance.
     AUTO MODE: "delegated — see ## Delegation." -->
> "<the principal's own words>"

## Delegation
<!-- AUTO MODE: required. The LIVE standing contract that delegates closure, by id — the one
     the principal ratified; quote the line it turns on. The close is executed in their name,
     so it appears in `mp acts` and they repudiate it item by item afterwards. A repudiation
     — `mp supersede mission:<Mission> --by principal --reason "<their verbatim words>"` —
     REOPENS the mission; the work it names is done, and the next close is v<NN+1> of this
     note. SIGN-OFF MODE: "not delegated — closed in person." -->
- `contract:<id>` — "<the contract line, quoted>" / not delegated — closed in person.

## Outcome
<!-- Prose, plainly, and the last thing anyone reads about this mission: what it actually
     delivered against the Charter's goal, and what stays open. Honest about failures;
     nothing dressed up. Every open item here is already disposed in the flag ledger or
     carried by a follow-on — this section says so, it does not dispose anything. -->
- **Delivered:** <what the mission produced, against the goal the Charter froze>
- **Stays open:** <accepted risks, deferred work, follow-on missions — with where each is recorded> / nothing.
