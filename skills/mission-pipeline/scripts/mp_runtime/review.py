"""Content-addressed review inputs, scoped independently of the journal sequence.

The broker captures these at packet delivery, never at submission. The writer
recomputes them under its transaction lock. Original case facts are immutable;
an explicit, bounded rebase records a new target/authority reading separately.
"""
from .storage import digest
from .process import RuntimeRefusal
from .contracts import required_records, contract_digest
import time

REVIEW_ACTIONS = {"issue.screen", "case.resolve", "contest.decide", "audit.agree",
                  "latch.release", "review.rebase"}


def review_basis(state, subject):
    if ("case" in subject) == ("latch" in subject):
        raise RuntimeRefusal("INVALID_INPUT", "A review reading names exactly one case or latch")
    kind = "case" if "case" in subject else "latch"
    ident = subject.get(kind)
    value = state.get((kind, str(ident)), {}).get("data")
    if value is None:
        raise RuntimeRefusal("MISSING_REFERENCE", "Review subject does not exist")
    case = value if kind == "case" else state.get(("case", value.get("case")), {}).get("data")
    mission = value["mission"]
    scope = case["scope"] if case else {"tasks": value.get("tasks", []), "mission_wide": not value.get("tasks")}
    tasks, obligations = set(scope.get("tasks", [])), set(scope.get("obligations", []))
    if case:
        for (k, _), row in state.items():
            if k == "permit" and row["data"].get("case") == case["id"] and row["data"].get("active"):
                tasks.update(row["data"]["tasks"])
    keys = {(kind, str(ident)), ("root", mission), ("intake_head", mission)}
    keys.update((k, v["id"]) for k, v in required_records(state, mission))
    if case:
        keys.add(("case", case["id"]))
        keys.add((case["target_kind"], case["target"]))
    head = state.get(("intake_head", mission), {}).get("data", {})
    intake = state.get(("intake", head.get("intake")), {}).get("data", {})
    root = state.get(("root", mission), {}).get("data", {})
    authority = root.get("authority", intake.get("authority"))
    keys.update({("authority", authority), ("intake", intake.get("id")), ("candidate", intake.get("candidate"))})
    for (k, i), row in state.items():
        v = row["data"]
        if k == "task" and v.get("mission") == mission and (scope.get("mission_wide") or i in tasks or set(v.get("obligations", [])) & obligations):
            tasks.add(i)
            keys.add((k, i))
    domains = {state[key]["data"]["domain"] for key in keys if key in state and state[key]["data"].get("domain")}
    for (k, i), row in state.items():
        v = row["data"]
        if k == "grant" and v["authority"] == authority and v["scope"] in (mission, "project") and (
                scope.get("mission_wide") or not domains or domains.intersection(v["domains"])):
            keys.add((k, i))
        if k == "obligation" and i in obligations:
            keys.add((k, i))
        if k in ("report", "delivery", "requirement") and v.get("task") in tasks and (k == "requirement" or v.get("current")):
            keys.add((k, i))
        if k in ("job", "contest", "permit") and case and v.get("case") == case["id"]:
            keys.add((k, i))
        if k in ("barrier", "latch") and v.get("mission") == mission:
            s = v.get("scope", {"tasks": v.get("tasks", []), "mission_wide": not v.get("tasks")})
            if scope.get("mission_wide") or s.get("mission_wide") or set(s.get("tasks", [])) & tasks or set(s.get("obligations", [])) & obligations:
                keys.add((k, i))
    # Include actual accepted-run identities and immutable output/input manifests.
    for (k, i), row in state.items():
        if k == "run" and ("requirement", row["data"].get("requirement")) in keys:
            keys.add((k, i))
    refs, blobs = [], set()
    def collect(v):
        if isinstance(v, dict):
            for key, child in v.items():
                if (key.endswith("_blob") or key == "blob") and isinstance(child, str):
                    blobs.add(child)
                elif key == "inputs" and isinstance(child, list):
                    blobs.update(x for x in child if isinstance(x, str) and len(x) == 64)
                collect(child)
        elif isinstance(v, list):
            for child in v:
                collect(child)
    for k, i in sorted((k, i) for k, i in keys if i is not None):
        row = state.get((k, i))
        if row:
            v = row["data"]
            effective = bool(v.get("active") and (not v.get("expires") or time.time() < v["expires"])) if k == "grant" else None
            refs.append([k, i, digest([v, effective]) if k == "grant" else digest(v)])
            collect(row["data"])
    target = state.get((case["target_kind"], case["target"]), {}).get("data") if case else value
    authority_refs = [r for r in refs if r[0] in ("authority", "grant", "intake_head", "candidate", "root")]
    return {"subject": {kind: str(ident)}, "refs": refs, "blobs": sorted(blobs),
            "head": digest([target, authority_refs, contract_digest(state, mission)])}
