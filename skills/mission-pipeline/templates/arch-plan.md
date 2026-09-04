<!-- mp:header
mission: <Mission>
category: ArchPlan
key: <Mission>
round: 0
version: <NN>
derives-from: none
-->
<!-- Seal with one call: python3 <skill>/scripts/mp seal <this file>. Every record is
     derived from the text; nothing is registered by hand. See references/substrate.md. -->
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

### Seams (tasks in one wave that consume each other's output)
<!-- A seam found is a finding, not a suggestion: each obliges a seam-contract file
     frozen BEFORE the fork, owned by one task and cited by section in both specs, plus an
     integration round for the wave (references/parallel.md). Say so when a wave has none. -->
| Wave | Producer → consumer | The value that crosses | Where its definition should live |
|---|---|---|---|
| <N> | T<i> → T<j> | <the payload / call / record> | `<proposed seam contract file>` |

- Waves with **no** cross-group seam: <list> — no integration round owed.

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
| `touches-contract` wrong against the measured footprint (an interface, data shape, or verification path changes → yes) | <T<n>: declared no, touches `<contract>`> / none |

### Unstated assumptions
<!-- Premises the specs rely on that no document states. Which task breaks if each is false.
     Feed the PM's delta veto — most critical first. -->
- <assumption — breaks T<n> if false> / None.

### Unverified
<!-- Claims not grounded in files actually read. Empty = everything verified. -->
- <claim> / None.
