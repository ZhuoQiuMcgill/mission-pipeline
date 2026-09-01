<!-- mp:header
mission: <Mission>
category: ArchPlan
key: <Mission>
round: 0
version: <NN>
derives-from: none
-->
<!-- IDs in the header come from mp artifact new — never invented. See references/substrate.md. -->
# ArchPlan — <Mission>

- **Role:** Architect · **Date:** <YYYY-MM-DD> · **Version:** v01 (map) / v02 (adds schedule)

## Pass 1 — Structural map
### Modules in play
| Module / area | Responsibility | Relevance to this mission |
|---|---|---|

### Key contracts
| Contract | Lives at | Depended on by |
|---|---|---|

### Load-bearing files & coupling
<!-- Files many things import or depend on; hotspots where parallel edits would collide. -->
- `path` — <why it's load-bearing>

### Constraints on splitting the work
- <what limits how tasks can be cut>

---

## Pass 2 — Schedule (v02)
### Task → footprint
| Task | Files it will touch | Depends on | Collides with |
|---|---|---|---|
| T1 | `…` | — | — |

### Waves
| Wave | Tasks | Rationale |
|---|---|---|
| 1 | T1, T2, … | independent, disjoint files |
| 2 | … | unblocked once wave 1 lands |

### Collisions & resolutions proposed
<!-- Facts are authoritative; the resolution is a proposal — the PM disposes. -->
- T<i> × T<j> on `path` → propose: serialize / isolate / re-cut at <seam>

### Task-cut advice
- <where re-cutting along a module seam unlocks parallelism>

### Spec lint (cold read — feeds the PM's delta veto)
| Check | Finding |
|---|---|
| Pointer requirements (defer to another doc, unexpanded) | <T<n> req <#> → doc §> / none |
| Unanchorable acceptance criteria (no conceivable R or F anchor — invariant 13) | <T<n> criterion <#>> / none |
| Charter contradiction (requirement/criterion vs a quoted Charter line) | <T<n> req <#> vs Charter: "<line>"> / none |
| Verification-scope regression vs earlier waves & the closing gate | <dropped command/path, since T<n>> / none |
| Out-of-scope missing or empty | <T<n>> / none |

### Unstated assumptions
<!-- Premises the specs rely on that no document states. Which task breaks if each is false.
     Feed the PM's delta veto — most critical first. -->
- <assumption — breaks T<n> if false> / None.

### Unverified
<!-- Claims not grounded in files actually read. Empty = everything verified. -->
- <claim> / None.
