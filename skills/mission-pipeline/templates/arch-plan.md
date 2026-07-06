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

### Unverified
<!-- Claims not grounded in files actually read. Empty = everything verified. -->
- <claim> / None.
