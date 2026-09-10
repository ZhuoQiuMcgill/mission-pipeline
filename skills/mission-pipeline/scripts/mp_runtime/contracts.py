"""One interpretation of contract applicability for readers and writers.

Source mission is provenance. Project/legacy_project scope survives new roots,
and an authority replacement alone does not retire a standing contract.
"""
import time
import math
from .storage import digest
from .process import RuntimeRefusal


def validate_policies(policies, clauses):
    if not isinstance(policies, dict) or set(policies) - set(clauses):
        raise RuntimeRefusal("INVALID_CONTRACT_POLICY", "Policies must name a principal constraint")
    for policy in policies.values():
        if not isinstance(policy, dict) or set(policy) - {"applicability", "expiry", "precedence"}:
            raise RuntimeRefusal("INVALID_CONTRACT_POLICY", "Unknown contract policy field")
        value = policy.get("applicability")
        if isinstance(value, dict):
            if set(value) - {"missions", "exclude_missions"} or any(
                    not isinstance(ids, list) or any(not isinstance(x, str) or not x for x in ids)
                    for ids in value.values()):
                raise RuntimeRefusal("INVALID_CONTRACT_POLICY", "Applicability uses explicit mission id lists")
        elif value not in (None, "all", "all reports", "project"):
            raise RuntimeRefusal("INVALID_CONTRACT_POLICY", "Native applicability must be structured")
        expiry = policy.get("expiry")
        if expiry is not None and (isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry)):
            raise RuntimeRefusal("INVALID_CONTRACT_POLICY", "Expiry must be a finite Unix timestamp")
        if policy.get("precedence", "principal") != "principal":
            raise RuntimeRefusal("INVALID_CONTRACT_POLICY", "Principal constraints combine without implicit overrides")


def compile_candidate(authority, candidate):
    """Compile from principal fields; validate every duplicate before deduplication."""
    items = {}
    for item in candidate["contracts"]:
        clause = item.get("clause")
        if item.get("authority") != authority["id"] or clause not in authority["constraints"]:
            raise RuntimeRefusal("CONTRACT_AUTHORITY_REQUIRED", "Contract needs its original principal clause")
        scope = "project" if authority.get("constraint_scopes", {}).get(clause, "mission") == "project" else candidate["mission"]
        if item.get("scope") != scope:
            raise RuntimeRefusal("CONTRACT_AUTHORITY_REQUIRED", "Candidate scope must preserve the principal scope in both directions")
        policy = authority.get("constraint_policies", {}).get(clause, {})
        for field in ("applicability", "expiry", "precedence"):
            if field in item and item[field] not in (None, "all reports", "principal") and item[field] != policy.get(field):
                raise RuntimeRefusal("CONTRACT_AUTHORITY_REQUIRED", "Candidate policy differs from principal authorization")
        items[clause] = dict(authority=authority["id"], clause=clause, scope=scope, **policy)
    for clause, scope in authority.get("constraint_scopes", {}).items():
        if scope == "project":
            items[clause] = dict(authority=authority["id"], clause=clause, scope="project",
                                 **authority.get("constraint_policies", {}).get(clause, {}))
    return [items[clause] for clause in sorted(items)]


def applicability(value, mission):
    if value is None or value in ("all", "all reports", "project"):
        return True
    if isinstance(value, dict) and set(value).issubset({"missions", "exclude_missions"}):
        return (not value.get("missions") or mission in value["missions"]) and mission not in value.get("exclude_missions", [])
    # Legacy free-text applicability is retained conservatively; a role reads it.
    if isinstance(value, str):
        return True
    raise RuntimeRefusal("INVALID_CONTRACT_APPLICABILITY", "Use explicit missions/exclude_missions for narrowed applicability")


def applicable_contracts(state, mission, now=None):
    now = time.time() if now is None else now
    result = []
    for (kind, _), row in sorted(state.items()):
        if kind != "contract":
            continue
        value = row["data"]
        if not value.get("active") or (value.get("expiry") is not None and now >= value["expiry"]):
            continue
        scope = value.get("scope", "legacy_project")
        if scope not in ("project", "legacy_project") and (value.get("mission") != mission or scope not in (mission, "mission")):
            continue
        if not applicability(value.get("applicability"), mission):
            continue
        authority = state.get(("authority", value.get("authority")), {}).get("data", {})
        result.append(dict(value, source_blob=value.get("source_blob") or authority.get("source_blob"),
                           value=value.get("value", authority.get("constraints", {}).get(value.get("clause")))))
    return result


def contract_digest(state, mission):
    return digest(applicable_contracts(state, mission))


def constraints(state, mission):
    reserved = {}
    for contract in applicable_contracts(state, mission):
        clause = contract.get("clause")
        if clause is None:  # Original unstructured legacy text remains in every relevant review.
            continue
        if clause in reserved and reserved[clause] != contract["value"]:
            raise RuntimeRefusal("AUTHORITY_CONFLICT", "Active principal contracts conflict; only their owning authority can change them")
        reserved[clause] = contract["value"]
    return reserved


def required_records(state, mission):
    result = []
    for contract in applicable_contracts(state, mission):
        result.append(("contract", contract))
        authority = state.get(("authority", contract.get("authority")), {}).get("data")
        if authority:
            result.append(("authority", authority))
    return result
