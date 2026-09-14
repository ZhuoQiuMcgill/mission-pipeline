"""Pure state transitions. All positive uses recheck live scoped barriers.

Natural-language judgments are signed role submissions, never inferred from an
actor label. The managed broker supplies Actor; local submissions are marked as
self-asserted and cannot write a managed ledger.
"""
import dataclasses
import time
import uuid

from .process import RuntimeRefusal
from .storage import digest
from .review import review_basis, REVIEW_ACTIONS
from .contracts import applicable_contracts, contract_digest, constraints, validate_policies, compile_candidate


@dataclasses.dataclass(frozen=True)
class Actor:
    role: str
    session: str
    authenticated: bool = False

    def record(self):
        return dataclasses.asdict(self)


ROLES = {"principal", "pm", "constructor", "crititor", "stabilizer", "supervisor",
         "architect", "calibrator", "challenger", "auditor", "controller", "researcher"}
BLOCKED = {"PENDING_SCREEN", "ESTABLISHED_HOLD", "CONTEST_PENDING",
           "SCREENING_UNAVAILABLE", "UNRESOLVED_LIMIT"}
TERMINAL_TASK = {"ACCEPTED", "AUTHORIZED_CANCELLED", "AUTHORIZED_DEFERRED", "REPLACED"}


def refuse(code, detail, **fields):
    raise RuntimeRefusal(code, detail, **fields)


class Workflow:
    def __init__(self, store, actor):
        self.store, self.actor = store, actor
        if actor.role not in ROLES:
            refuse("UNKNOWN_ROLE", "Unknown role")

    def apply(self, state, request):
        self.state, self.request = state, request
        self.now = time.time()
        config = self.optional("config", "project") or {}
        if config.get("mode") == "managed" and not self.actor.authenticated:
            refuse("AUTHENTICATED_ENDPOINT_REQUIRED", "Use a controller-assigned managed endpoint")
        action = request.get("action", "")
        handler = getattr(self, "do_" + action.replace(".", "_"), None)
        if handler is None or action.startswith("_"):
            refuse("UNKNOWN_ACTION", "Unsupported workflow action", action=action)
        if action in REVIEW_ACTIONS:
            data = request.get("data", {})
            subject_kind = "latch" if action == "latch.release" else "case"
            basis = review_basis(state, {subject_kind: data.get(subject_kind)})
            if data.get("review_basis") != basis:
                refuse("STALE_REVIEW_INPUT", "Read the current scoped review packet before submitting; no metadata is refreshed at commit")
            referenced = {(r[0], r[1]) for r in basis["refs"]}
            named = [("task", tid) for tid in data.get("repair_tasks", [])]
            named += [(kind, data[field]) for field, kind in (("candidate", "candidate"), ("grant", "grant")) if data.get(field)]
            if any(key not in referenced for key in named):
                refuse("REVIEW_INPUT_OUTSIDE_SCOPE", "Review names an input outside this case reading; register its scoped recovery first")
            if config.get("mode") == "managed" and self.actor.role != "principal" and not set(basis["blobs"]).issubset(data.get("input_receipt", {}).get("read_blobs", [])):
                refuse("INPUT_NOT_READ", "The authenticated endpoint must read the actual review inputs")
            if action != "review.rebase" and data.get("case"):
                case = self.get("case", data["case"])
                legacy_target_changed = not case.get("review_head") and digest(self.get(case["target_kind"], case["target"])) != case["target_digest"]
                if legacy_target_changed or case.get("review_head", basis["head"]) != basis["head"]:
                    refuse("REVIEW_REBASE_REQUIRED", "Target or applicable authority changed; explicitly rebase this same case after rereading")
        return handler(request.get("data", {}))

    def do_review_rebase(self, d):
        self.only("supervisor", "stabilizer", "auditor")
        case = self.get("case", d["case"])
        for job in self.rows("job", case=case["id"]):
            role = "supervisor" if job["kind"] == "screen" else "stabilizer"
            if role == self.actor.role and job.get("occupied") and job.get("instance") != self.actor.session:
                refuse("INDEPENDENCE_REQUIRED", "Only the assigned endpoint may rebase an occupied review")
        if self.get("barrier", case["id"])["phase"] not in BLOCKED:
            refuse("CASE_NOT_ACTIVE", "Only an unresolved case can be rebased")
        head = d["review_basis"]["head"]
        if case.get("review_head") == head:
            return {"case": case, "reused": True}
        self.charge(case["id"], "review_rebase", 2)
        history = case.get("review_rebases", []) + [{"from": case.get("review_head"), "to": head,
                  "basis": d["review_basis"], "reader": self.actor.record(), "time": self.now}]
        return {"case": self.update("case", case["id"], review_head=head, review_rebases=history)}

    def only(self, *roles):
        if self.actor.role not in roles:
            refuse("ROLE_FORBIDDEN", "This endpoint cannot perform this transition")

    def optional(self, kind, id):
        row = self.state.get((kind, str(id)))
        return row["data"] if row else None

    def get(self, kind, id):
        value = self.optional(kind, id)
        if value is None:
            refuse("MISSING_REFERENCE", "Referenced object does not exist", kind=kind, id=id)
        return value

    def rows(self, object_kind, **match):
        return [row["data"] for (k, _), row in self.state.items() if k == object_kind
                and all(row["data"].get(a) == b for a, b in match.items())]

    def put(self, kind, id, value):
        key = kind, str(id)
        self.state[key] = {"revision": self.state.get(key, {}).get("revision", 0),
                           "data": dict(value, id=str(id))}
        return self.state[key]["data"]

    def create(self, kind, value, id=None):
        id = id or kind + "-" + uuid.uuid4().hex
        if self.optional(kind, id):
            refuse("ALREADY_EXISTS", "Object id already exists", kind=kind, id=id)
        return self.put(kind, id, dict(value, author=self.actor.record(), created=self.now))

    def update(self, kind, id, **changes):
        value = self.get(kind, id)
        return self.put(kind, id, dict(value, **changes))

    def blob(self, sha):
        self.store.blobs.get(sha)
        return sha

    def charge(self, lineage, category, cap):
        key = lineage + ":" + category
        row = self.optional("budget", key) or {"count": 0}
        if row["count"] >= cap:
            refuse("BUDGET_EXHAUSTED", "Finite correction budget exhausted", category=category)
        self.put("budget", key, {"count": row["count"] + 1})

    def fence(self, mission):
        return (self.optional("fence", mission) or {}).get("value", 0)

    def bump(self, mission):
        self.put("fence", mission, {"value": self.fence(mission) + 1})

    def authority_digest(self, mission):
        root = self.optional("root", mission)
        if not root:
            intakes = self.rows("intake", mission=mission)
            if not intakes:
                refuse("MISSING_REFERENCE", "Mission has neither active root nor pre-active intake")
            root = intakes[-1]
        auth = self.get("authority", root["authority"])
        grants = [g for g in self.rows("grant") if g["authority"] == auth["id"]]
        return digest([auth, sorted(grants, key=lambda x: x["id"]), contract_digest(self.state, mission)])

    def grant(self, id, domain, mission, effect=None, permission="choose"):
        grant = self.get("grant", id)
        if not self.get("authority", grant["authority"])["active"]:
            refuse("AUTHORITY_CONFLICT", "The principal authority was superseded")
        root = self.optional("root", mission)
        if root and grant["authority"] != root["authority"]:
            refuse("AUTHORITY_CONFLICT", "Delegation belongs to another principal authority")
        if not grant["active"] or (grant.get("expires") and self.now >= grant["expires"]):
            refuse("AUTHORITY_CONFLICT", "Delegation is revoked or expired")
        if domain not in grant["domains"] or permission not in grant["permissions"]:
            refuse("AUTHORITY_CONFLICT", "Decision is outside the delegation domain or permission")
        if grant["scope"] not in (mission, "project"):
            refuse("AUTHORITY_CONFLICT", "Delegation does not cover this mission")
        auth = self.get("authority", grant["authority"])
        reserved = {k: v for k, v in auth["constraints"].items() if auth.get("constraint_scopes", {}).get(k, "mission") != "project"}
        for key, value in constraints(self.state, mission).items():
            if key in reserved and reserved[key] != value:
                refuse("AUTHORITY_CONFLICT", "Mission authority conflicts with an applicable standing contract", clause=key)
            reserved[key] = value
        for key, value in grant.get("reserved", {}).items():
            if key in reserved and reserved[key] != value:
                refuse("AUTHORITY_CONFLICT", "A grant cannot override a standing contract", clause=key)
            reserved[key] = value
        for key, value in (effect or {}).items():
            if key in reserved and value != reserved[key]:
                refuse("AUTHORITY_CONFLICT", "Decision conflicts with a reserved principal condition", clause=key)
        return grant

    def relevant(self, barrier, mission, tasks, obligations):
        if barrier["mission"] != mission:
            return False
        scope = barrier["scope"]
        return (scope.get("mission_wide", False)
                or bool(set(scope.get("tasks", [])) & set(tasks))
                or bool(set(scope.get("obligations", [])) & set(obligations)))

    def qualify(self, mission, tasks=(), obligations=(), permit=None, closing=False):
        constraints(self.state, mission)
        selected = [self.get("task", tid) for tid in tasks]
        for decision in self.rows("decision", mission=mission, current=True):
            if closing or any(self.decision_applies(decision, task) for task in selected):
                self.grant(decision["grant"], decision["domain"], mission, decision["effects"],
                           "revise" if decision.get("revises") else "choose")
        root = self.optional("root", mission)
        if root and root["status"] == "CLOSED":
            refuse("MISSION_CLOSED", "Closed missions require explicit principal reopening before positive work")
        except_case = None
        if permit:
            p = self.get("permit", permit)
            if not p["active"] or p["expires"] <= self.now or p["mission"] != mission:
                refuse("INVALID_RECOVERY_PERMIT", "Recovery permit is expired or out of scope")
            if not set(tasks).issubset(p["tasks"]) or closing:
                refuse("RECOVERY_SCOPE_CONFLICT", "Permit cannot authorize this positive use")
            if p["authority_digest"] != self.authority_digest(mission):
                refuse("STALE_AUTHORITY", "Recovery permission authority changed")
            except_case = p["case"]
        for barrier in self.rows("barrier", mission=mission):
            if barrier["phase"] in BLOCKED and barrier["case"] != except_case and (
                    closing or self.relevant(barrier, mission, tasks, obligations)):
                refuse("SCOPED_BARRIER", "An unresolved counterexample blocks this positive use",
                       case=barrier["case"], phase=barrier["phase"])
        for latch in self.rows("latch", mission=mission):
            if latch["active"] and (closing or not latch.get("tasks") or set(tasks) & set(latch["tasks"])):
                if not permit or latch.get("case") != except_case:
                    refuse("CALIBRATION_HALT", "Applicable calibration latch is active", latch=latch["id"])

    def do_project_configure(self, d):
        self.only("principal", "controller")
        mode = d.get("mode", "local")
        if mode not in ("local", "managed"):
            refuse("INVALID_MODE", "Mode must be local or managed")
        if mode == "managed" and not self.actor.authenticated:
            refuse("AUTHENTICATED_ENDPOINT_REQUIRED", "Managed mode is established by the trusted controller")
        return {"config": self.put("config", "project", {"mode": mode, "version": 4})}

    def do_authority_record(self, d):
        self.only("principal")
        text = self.blob(d["source_blob"])
        scopes = d.get("constraint_scopes", {})
        if not isinstance(scopes, dict) or any(key not in d.get("constraints", {}) or value not in ("mission", "project") for key, value in scopes.items()):
            refuse("INVALID_AUTHORITY_SCOPE", "Constraint scopes must name principal constraints and be mission or project")
        validate_policies(d.get("constraint_policies", {}), d.get("constraints", {}))
        auth = self.create("authority", {"source_blob": text, "active": True,
                           "goals": d.get("goals", []), "constraints": d.get("constraints", {}),
                           "constraint_scopes": scopes,
                           "constraint_policies": d.get("constraint_policies", {}),
                           "source_assurance": "managed-ingress" if self.actor.authenticated else "self-asserted"}, d.get("id"))
        return {"authority": auth}

    def do_authority_amend(self, d):
        self.only("principal")
        previous = self.get("authority", d["previous"])
        if not previous["active"]:
            refuse("STALE_AUTHORITY", "Amend the current principal source")
        result = self.do_authority_record(d)
        authority = self.update("authority", result["authority"]["id"], replaces=previous["id"])
        self.update("authority", previous["id"], active=False)
        for root in self.rows("root", authority=previous["id"]):
            self.bump(root["id"])
        return {"authority": authority}

    def do_contract_retire(self, d):
        self.only("principal")
        contract = self.get("contract", d["contract"])
        authority = self.get("authority", d["authority"])
        owner = authority
        while owner["id"] != contract.get("authority") and owner.get("replaces"):
            owner = self.get("authority", owner["replaces"])
        if owner["id"] != contract.get("authority") or not authority["active"]:
            refuse("CONTRACT_AUTHORITY_REQUIRED", "Only the contract's owning current principal authority can explicitly retire it")
        self.blob(d["source_blob"])
        if not contract["active"]:
            refuse("STALE_CONTRACT", "This contract is already retired")
        return {"contract": self.update("contract", contract["id"], active=False,
                retirement_blob=d["source_blob"], retired_by=authority["id"], retired_at=self.now)}

    def do_grant_record(self, d):
        self.only("principal")
        authority = self.get("authority", d["authority"])
        if not authority["active"]:
            refuse("STALE_AUTHORITY", "A grant must derive from active principal authority")
        if any(key in authority["constraints"] and authority["constraints"][key] != value
               for key, value in d.get("reserved", {}).items()):
            refuse("AUTHORITY_CONFLICT", "Changing a principal condition requires authority.amend, not a grant override")
        self.blob(d["source_blob"])
        grant = self.create("grant", dict(authority=d["authority"], source_blob=d["source_blob"],
                            scope=d["scope"], domains=d["domains"], permissions=d.get("permissions", ["choose", "revise"]),
                            reserved=d.get("reserved", {}), expires=d.get("expires"), active=True), d.get("id"))
        return {"grant": grant}

    def do_grant_revoke(self, d):
        self.only("principal")
        grant = self.update("grant", d["grant"], active=False)
        for root in self.rows("root"):
            if root["authority"] == grant["authority"]:
                self.bump(root["id"])
        return {"grant": grant}

    def do_intake_create(self, d):
        self.only("pm", "principal")
        self.get("authority", d["authority"])
        old = self.optional("intake_head", d["mission"])
        if old and d.get("revises_intake") != old["intake"]:
            refuse("STALE_HEAD", "A new intake must identify its mission's current intake")
        intake = self.create("intake", {"authority": d["authority"], "mission": d["mission"],
                              "lineage": self.get("intake", old["intake"])["lineage"] if old else d["mission"], "candidate": None}, d.get("id"))
        self.put("intake_head", d["mission"], {"intake": intake["id"]})
        return {"intake": intake}

    def do_root_propose(self, d):
        self.only("pm")
        intake = self.get("intake", d["intake"])
        if self.get("intake_head", intake["mission"])["intake"] != intake["id"]:
            refuse("STALE_HEAD", "This pre-active intake has been replaced")
        auth = self.get("authority", intake["authority"])
        if d.get("revises") != intake["candidate"]:
            refuse("STALE_HEAD", "Candidate must revise the current intake head")
        self.blob(d["source_blob"])
        candidate = self.create("candidate", dict(intake=intake["id"], mission=intake["mission"],
                                authority=auth["id"], authority_digest=digest(auth), source_blob=d["source_blob"],
                                goals=d.get("goals", []), contracts=d.get("contracts", []),
                                revises=d.get("revises"), status="CANDIDATE"), d.get("id"))
        self.update("intake", intake["id"], candidate=candidate["id"])
        return {"candidate": candidate}

    def do_root_review(self, d):
        self.only("supervisor")
        candidate = self.get("candidate", d["candidate"])
        self.check_contract_reading(candidate["mission"], d)
        if candidate["id"] != self.get("intake", candidate["intake"])["candidate"]:
            refuse("STALE_DEPENDENCY", "Review target is not the current candidate")
        auth = self.get("authority", candidate["authority"])
        if d["outcome"] not in ("MATCH", "MISMATCH", "INPUT_INCOMPLETE"):
            refuse("INVALID_VERDICT", "Invalid root review outcome")
        self.blob(d["source_blob"])
        if d["outcome"] == "MATCH" and set(auth["goals"]) != set(candidate["goals"]):
            refuse("GOAL_COVERAGE_GAP", "Candidate goal inventory differs from the principal goal inventory")
        if d["outcome"] == "MATCH":
            compile_candidate(auth, candidate)
        for key, value in constraints(self.state, candidate["mission"]).items():
            if key in auth["constraints"] and auth["constraints"][key] != value:
                refuse("AUTHORITY_CONFLICT", "Candidate authority contradicts an existing applicable contract")
        review = self.create("review", {"kind": "root", "mission": candidate["mission"], "target": candidate["id"],
                              "target_digest": digest(candidate), "authority_digest": digest(auth),
                              "contract_scope_digest": contract_digest(self.state, candidate["mission"]),
                              "outcome": d["outcome"], "source_blob": d["source_blob"]}, d.get("id"))
        return {"review": review}

    def do_root_activate(self, d):
        self.only("pm")
        c = self.get("candidate", d["candidate"])
        intake = self.get("intake", c["intake"])
        if self.get("intake_head", c["mission"])["intake"] != intake["id"]:
            refuse("STALE_HEAD", "A replaced intake cannot activate old contracts")
        r = self.get("review", d["review"])
        auth = self.get("authority", c["authority"])
        legacy = self.optional("legacy_inventory", "source")
        if legacy:
            matches = [m for m in legacy["missions"].values() if m.get("name") == c["mission"]]
            if matches and not self.optional("legacy_scope", c["mission"]):
                refuse("LEGACY_SCOPE_ADOPTION_REQUIRED", "Adopt this open legacy scope and its calibration bridge before activation")
        self.qualify(c["mission"], obligations=c["goals"], closing=True)
        if intake["candidate"] != c["id"] or r["target"] != c["id"] or r["outcome"] != "MATCH" \
                or r["target_digest"] != digest(c) or r["authority_digest"] != digest(auth) or not auth["active"] \
                or r.get("contract_scope_digest") != contract_digest(self.state, c["mission"]):
            refuse("STALE_ROOT_REVIEW", "Activation requires the current independently matched candidate")
        old = self.optional("root", c["mission"])
        if old and d.get("revises_root") != old["candidate"]:
            refuse("STALE_HEAD", "Activation must identify the active root being revised")
        if old and old["authority"] != auth["id"] and auth.get("replaces") != old["authority"]:
            refuse("AUTHORITY_CONFLICT", "Changing direction requires the principal's explicit authority amendment")
        items = compile_candidate(auth, c)
        root = self.put("root", c["mission"], dict(candidate=c["id"], authority=auth["id"],
                        version=(old or {}).get("version", 0) + 1, lineage=intake["lineage"], status="OPEN"))
        self.update("candidate", c["id"], status="ACTIVE")
        for item in items:
            existing = [x for x in self.rows("contract", authority=auth["id"], clause=item["clause"])
                        if x["scope"] == item["scope"] and (item["scope"] == "project" or x["mission"] == c["mission"])]
            if not existing:  # Omission or a new candidate never retires/recreates old restrictions.
                self.create("contract", dict(item, mission=c["mission"], active=True, principal_ratified=True,
                           source_blob=auth["source_blob"], value=auth["constraints"][item["clause"]]))
        self.bump(c["mission"])
        if not self.optional("wave", c["mission"] + ":1"):
            self.put("wave", c["mission"] + ":1", {"mission": c["mission"], "number": 1, "status": "OPEN"})
        return {"root": root}

    def do_legacy_adopt(self, d):
        self.only("pm", "principal")
        inventory = self.get("legacy_inventory", "source")
        old = inventory["missions"].get(str(d["legacy_mission"]))
        if old is None:
            old = inventory["missions"].get(d["legacy_mission"])
        if not old or old["name"] != d["mission"]:
            refuse("LEGACY_SCOPE_MISMATCH", "Adoption must name the exact legacy mission")
        if old["status"] == "closed" and (self.actor.role != "principal" or not d.get("reopen")):
            refuse("LEGACY_MISSION_CLOSED", "Closed history stays closed without a new principal reopening")
        self.blob(d["source_blob"])
        if d.get("artifacts") is None:
            # Omitted: adopt the whole verified evidence of that legacy mission.
            artifacts = []
            for item in inventory.get("overlays", []):
                if str(item.get("mission")) == str(d["legacy_mission"]) and item["status"] == "VERIFIED" \
                        and str(item["artifact"]) not in artifacts:
                    artifacts.append(str(item["artifact"]))
        else:
            artifacts = [str(aid) for aid in d["artifacts"]]
            for aid in artifacts:
                overlay = self.get("semantic_overlay", aid)
                if overlay["status"] != "VERIFIED":
                    refuse("LEGACY_EVIDENCE_UNAVAILABLE", "Unavailable legacy bytes cannot be adopted as current evidence")
        adopted = [a for a in inventory.get("acceptances", [])
                   if str(a["legacy_mission"]) == str(d["legacy_mission"]) and str(a["artifact"]) in artifacts]
        for latch in self.rows("legacy_latch"):
            if str(latch["mission"]) == str(d["legacy_mission"]):
                self.put("latch", "legacy:" + latch["id"], dict(latch, mission=d["mission"], tasks=[], legacy_recorded=True))
        scope = self.put("legacy_scope", d["mission"], dict(mission=d["mission"], legacy_mission=d["legacy_mission"],
                         source_blob=d["source_blob"], artifacts=artifacts, acceptances=adopted,
                         current_acceptance="REQUIRES_REQUALIFICATION"))
        return {"scope": scope}

    def do_legacy_accept(self, d):
        """Credit one recorded v3 acceptance to one current obligation.

        The bytes are the adopted, hash-verified legacy document; the judgement is
        the stabilizer's sealed ACCEPTED verdict. Both are named on the obligation
        as `legacy-recorded`, never as evidence this runtime itself qualified.
        """
        self.only("pm")
        scope = self.optional("legacy_scope", d["mission"])
        if not scope:
            refuse("LEGACY_SCOPE_ADOPTION_REQUIRED", "Adopt this legacy scope before crediting its recorded acceptances")
        artifact = str(d["legacy_artifact"])
        if artifact not in [str(a) for a in scope.get("artifacts", [])]:
            refuse("LEGACY_EVIDENCE_UNAVAILABLE", "This artifact is not part of the adopted legacy scope", artifact=artifact)
        overlay = self.get("semantic_overlay", artifact)
        if overlay["status"] != "VERIFIED":
            refuse("LEGACY_EVIDENCE_UNAVAILABLE", "Unavailable legacy bytes cannot satisfy a current obligation")
        matching = [a for a in scope.get("acceptances", []) if str(a["artifact"]) == artifact]
        if not matching:
            refuse("LEGACY_ACCEPTANCE_MISSING", "No sealed legacy ACCEPTED verdict cites this artifact", artifact=artifact)
        acceptance = matching[-1]
        if acceptance.get("sha256") != overlay.get("source_sha256"):
            refuse("LEGACY_EVIDENCE_UNAVAILABLE", "Adopted bytes differ from the sealed acceptance hash", artifact=artifact)
        ob = self.get("obligation", d["obligation"])
        if ob["mission"] != d["mission"]:
            refuse("CROSS_MISSION_REFERENCE", "Obligation belongs to another mission")
        if ob["status"] != "REQUIRED":
            refuse("STALE_HEAD", "Only a required obligation takes a recorded legacy acceptance", status=ob["status"])
        self.qualify(d["mission"], obligations=[ob["id"]])
        return {"obligation": self.update("obligation", ob["id"], status="MET",
                evidence="legacy:" + artifact, assurance="legacy-recorded",
                accepted_task_key=acceptance.get("task_key"), legacy_acceptance=acceptance,
                legacy_scope=scope["mission"], source_blob=overlay.get("source_blob"))}

    def do_decision_record(self, d):
        self.only("pm")
        self.get("root", d["mission"])
        grant = self.grant(d["grant"], d["domain"], d["mission"], d.get("effects"), "revise" if d.get("revises") else "choose")
        targets = d.get("tasks", [])
        if d.get("revises"):
            previous = self.get("decision", d["revises"])
            if previous["mission"] != d["mission"] or not previous["current"]:
                refuse("STALE_HEAD", "Decision revision must target its current mission decision")
            targets = d.get("tasks", previous.get("tasks", []))
            self.update("decision", previous["id"], current=False)
        if not isinstance(targets, list) or any(not isinstance(tid, str) or self.get("task", tid)["mission"] != d["mission"] for tid in targets):
            refuse("CROSS_MISSION_REFERENCE", "Decision tasks must belong to its mission")
        decision = self.create("decision", dict(mission=d["mission"], grant=grant["id"],
                               grant_digest=digest(grant), domain=d["domain"], effects=d.get("effects", {}),
                               rationale_blob=self.blob(d["rationale_blob"]), choice=d["choice"],
                               revises=d.get("revises"), tasks=targets, current=True), d.get("id"))
        return {"decision": decision}

    @staticmethod
    def decision_applies(decision, task):
        return decision["domain"] == task["domain"] and (not decision.get("tasks") or task["id"] in decision["tasks"])

    def do_plan_record(self, d):
        self.only("pm")
        root = self.get("root", d["mission"])
        auth = self.get("authority", root["authority"])
        if set(d["goals"]) != set(auth["goals"]):
            refuse("GOAL_COVERAGE_GAP", "Plan omits a principal goal; PM rows are not the source of all goals")
        for item in d["obligations"]:
            if item["goal"] not in auth["goals"]:
                refuse("INVENTED_OBLIGATION", "Obligation must trace to a goal")
            old = self.optional("obligation", item["id"])
            if old and old["mission"] != d["mission"]:
                refuse("CROSS_MISSION_REFERENCE", "Obligation belongs to another mission")
            self.put("obligation", item["id"], dict(item, mission=d["mission"],
                     status=(old or {}).get("status", "REQUIRED")))
        if set(x["goal"] for x in d["obligations"]) != set(auth["goals"]):
            refuse("GOAL_COVERAGE_GAP", "Every principal goal needs a production obligation")
        plan = self.create("plan", dict(mission=d["mission"], goals=d["goals"],
                           obligations=[x["id"] for x in d["obligations"]],
                           source_blob=self.blob(d["source_blob"]), status="NOT_ADMITTED"), d.get("id"))
        return {"plan": plan}

    def do_task_record(self, d):
        self.only("pm")
        root = self.get("root", d["mission"])
        for oid in d["obligations"]:
            if self.get("obligation", oid)["mission"] != d["mission"]:
                refuse("CROSS_MISSION_REFERENCE", "Task obligation belongs to another mission")
        previous = self.optional("task", d["id"])
        if previous and d.get("revises") != digest(previous):
            refuse("STALE_HEAD", "Task update requires its current digest")
        if previous and previous["mission"] != d["mission"]:
            refuse("CROSS_MISSION_REFERENCE", "Task id belongs to another mission")
        task = self.put("task", d["id"], dict(mission=d["mission"], obligations=d["obligations"],
                        effects=d.get("effects", []), allowed_effects=d.get("allowed_effects", []),
                        inputs=d.get("inputs", []), required_runs=d.get("required_runs", []),
                        outputs=d.get("outputs", []),
                        write_paths=d.get("write_paths", d.get("outputs", [])),
                        dependencies=d.get("dependencies", []), lineage=(previous or {}).get("lineage", d["id"]),
                        wave=d.get("wave", (previous or {}).get("wave", 1)),
                        calibration_required=bool(d.get("recovers") or root["version"] > 1 or
                            (d.get("touches_contract") and self.optional("compaction", d["mission"]))),
                        grant=d["grant"], domain=d["domain"], source_blob=self.blob(d["source_blob"]),
                        status="NOT_ADMITTED", revision=(previous or {}).get("revision", 0) + 1))
        return {"task": task}

    def do_task_replace(self, d):
        self.only("pm")
        old = self.get("task", d["previous"])
        self.grant(old["grant"], old["domain"], old["mission"], permission="revise")
        if old["status"] == "REPLACED" or d["task"]["id"] == old["id"]:
            refuse("REPLACEMENT_CYCLE", "Replacement needs a current predecessor and a distinct new id")
        if self.optional("task", d["task"]["id"]) or set(d["task"]["obligations"]) != set(old["obligations"]):
            refuse("REPLACEMENT_SCOPE", "Replacement must preserve obligations and create a fresh task id")
        result = self.do_task_record(dict(d["task"], mission=old["mission"]))
        new = self.update("task", result["task"]["id"], lineage=old["lineage"], replaces=old["id"])
        self.update("task", old["id"], status="REPLACED", replacement=new["id"])
        return {"task": new}

    def dependency_digest(self, task, visiting=None):
        visiting = set(visiting or ())
        if task["id"] in visiting:
            refuse("DEPENDENCY_CYCLE", "Task dependencies contain a cycle")
        visiting.add(task["id"])
        dependencies = []
        for tid in task.get("dependencies", []):
            other = self.get("task", tid)
            if other["mission"] != task["mission"]:
                refuse("CROSS_MISSION_REFERENCE", "Task dependency is outside this mission")
            self.dependency_digest(other, visiting)
            accepted = self.task_acceptance(other)
            self.required_satisfied(other)
            dependencies.append([other, accepted])
        return digest(dependencies)

    def do_context_compacted(self, d):
        self.only("pm", "controller")
        self.get("root", d["mission"])
        return {"compaction": self.put("compaction", d["mission"], {"mission": d["mission"], "at": self.now})}

    def do_plan_review(self, d):
        self.only("supervisor")
        plan = self.get("plan", d["plan"])
        self.check_contract_reading(plan["mission"], d)
        tasks = [self.get("task", tid) for tid in d["tasks"]]
        if any(t["mission"] != plan["mission"] for t in tasks):
            refuse("CROSS_MISSION_REFERENCE", "Plan review includes another mission")
        if d["outcome"] == "PASS":
            covered = set()
            for task in tasks:
                self.grant(task["grant"], task["domain"], task["mission"])
                for decision in self.rows("decision", mission=task["mission"], current=True):
                    if self.decision_applies(decision, task):
                        self.grant(decision["grant"], decision["domain"], task["mission"], decision["effects"],
                                   "revise" if decision.get("revises") else "choose")
                if not set(task["effects"]).issubset(task["allowed_effects"]):
                    refuse("INFEASIBLE_TASK", "Required effect is excluded by the task permissions", task=task["id"])
                for item in task["inputs"]:
                    self.blob(item)
                covered.update(task["obligations"])
            if not set(plan["obligations"]).issubset(covered):
                refuse("MISSING_PRODUCER", "Every required outcome needs an authorized producer")
        review = self.create("review", dict(kind="plan", mission=plan["mission"], target=plan["id"],
                              target_digest=digest([plan, tasks]), tasks=d["tasks"],
                              authority_digest=self.authority_digest(plan["mission"]),
                              outcome=d["outcome"], source_blob=self.blob(d["source_blob"])), d.get("id"))
        return {"review": review}

    def check_contract_reading(self, mission, d):
        supplied = d.get("input_receipt", {}).get("contract_scope_digest") if (self.optional("config", "project") or {}).get("mode") == "managed" else d.get("contract_scope_digest", d.get("input_receipt", {}).get("contract_scope_digest"))
        if supplied != contract_digest(self.state, mission):
            refuse("STALE_CONTRACT_REVIEW", "Explicitly read the current applicable contracts before judging")

    def do_task_admit(self, d):
        self.only("pm")
        task = self.get("task", d["task"])
        wave = self.get("wave", task["mission"] + ":" + str(task["wave"]))
        if wave["status"] != "OPEN":
            refuse("WAVE_NOT_OPEN", "Task admission requires an open wave")
        review = self.get("review", d["review"])
        plan = self.get("plan", review["target"])
        tasks = [self.get("task", tid) for tid in review["tasks"]]
        self.qualify(task["mission"], [task["id"]], task["obligations"], d.get("permit"))
        if review["kind"] != "plan" or review["outcome"] != "PASS" or task["id"] not in review["tasks"] \
                or review["target_digest"] != digest([plan, tasks]) or review["authority_digest"] != self.authority_digest(task["mission"]):
            refuse("STALE_PLAN_REVIEW", "Admission requires a current independently reviewed plan")
        self.grant(task["grant"], task["domain"], task["mission"])
        admission = self.create("admission", dict(task=task["id"], mission=task["mission"],
                                 target_digest=digest(task), authority_digest=review["authority_digest"],
                                 dependency_digest=self.dependency_digest(task),
                                 fence=self.fence(task["mission"]), permit=d.get("permit")), d.get("id"))
        return {"admission": admission}

    def do_wave_open(self, d):
        self.only("pm")
        mission, number = d["mission"], d["number"]
        if not isinstance(number, int) or number < 1:
            refuse("INVALID_WAVE", "Wave numbers are positive integers")
        self.qualify(mission, tasks=d.get("tasks", []))
        if number > 1:
            previous = self.get("wave", mission + ":" + str(number - 1))
            if previous["status"] != "CLOSED":
                refuse("PREVIOUS_WAVE_OPEN", "Integrate the previous wave before opening its successor")
            calibrations = self.rows("calibration", mission=mission, wave=number - 1, task=None)
            if not calibrations or calibrations[-1]["outcome"] not in ("ALIGNED", "SUSPICION"):
                refuse("WAVE_CALIBRATION_REQUIRED", "The previous wave needs a completed calibration")
        return {"wave": self.create("wave", dict(mission=mission, number=number, status="OPEN"), mission + ":" + str(number))}

    def do_wave_integrate(self, d):
        self.only("pm")
        wave = self.get("wave", d["mission"] + ":" + str(d["number"]))
        tasks = self.rows("task", mission=d["mission"], wave=d["number"])
        self.qualify(d["mission"], tasks=[t["id"] for t in tasks], obligations=[oid for t in tasks for oid in t["obligations"]])
        for task in tasks:
            if task["status"] == "REPLACED":
                continue
            if all(self.get("obligation", oid)["status"] in ("AUTHORIZED_DEFERRED", "AUTHORIZED_CANCELLED") for oid in task["obligations"]):
                continue
            self.required_satisfied(task)
            self.task_acceptance(task)
        self.blob(d["source_blob"])
        return {"wave": self.update("wave", wave["id"], status="CLOSED", integration_blob=d["source_blob"])}

    def admission(self, id, consume=False):
        admission = self.get("admission", id)
        task = self.get("task", admission["task"])
        self.qualify(task["mission"], [task["id"]], task["obligations"], None if consume else admission.get("permit"))
        if admission["target_digest"] != digest(task) or admission["authority_digest"] != self.authority_digest(task["mission"]):
            refuse("STALE_ADMISSION", "The admitted task or authority has changed")
        if admission.get("dependency_digest") != self.dependency_digest(task):
            refuse("STALE_DEPENDENCY", "A consumed predecessor's qualified evidence changed")
        self.grant(task["grant"], task["domain"], task["mission"])
        return task

    def do_task_dispatch(self, d):
        self.only("pm", "constructor")
        task = self.admission(d["admission"])
        ticket = self.create("ticket", dict(admission=d["admission"], task=task["id"],
                             fence=self.task_fence(task), claimed=False), d.get("id"))
        return {"ticket": ticket}

    def task_fence(self, task):
        barriers = [b for b in self.rows("barrier") if self.relevant(b, task["mission"], [task["id"]], task["obligations"])]
        latches = [l for l in self.rows("latch", mission=task["mission"])
                   if not l.get("tasks") or task["id"] in l["tasks"]]
        return digest([self.authority_digest(task["mission"]), barriers, latches])

    def do_task_claim(self, d):
        self.only("constructor")
        ticket = self.get("ticket", d["ticket"])
        task = self.admission(ticket["admission"])
        if ticket["claimed"] or ticket["fence"] != self.task_fence(task):
            refuse("STALE_TICKET", "Queued ticket is already claimed or fenced")
        self.update("ticket", ticket["id"], claimed=True, claimant=self.actor.record())
        return {"task": task, "claimed": True}

    def do_consume(self, d):
        self.only("pm", "constructor", "stabilizer")
        task = self.admission(d["admission"], consume=True)
        if any(self.get("obligation", oid)["status"] == "MET" for oid in task["obligations"]):
            self.required_satisfied(task)
            self.task_acceptance(task)
        for oid in d.get("obligations", task["obligations"]):
            ob = self.get("obligation", oid)
            if ob["mission"] != task["mission"]:
                refuse("CROSS_MISSION_REFERENCE", "Consumed outcome belongs to another mission")
            self.qualify(task["mission"], [task["id"]], [oid])
            if ob["status"] not in ("MET", "AUTHORIZED_DEFERRED", "AUTHORIZED_CANCELLED"):
                refuse("UNMET_OBLIGATION", "Formal consumption requires a qualified outcome", obligation=oid)
        receipt = self.create("consumption", dict(task=task["id"], mission=task["mission"],
                                  admission=d["admission"], obligations=d.get("obligations", task["obligations"])))
        return {"consumption": receipt}

    def do_issue_report(self, d):
        self.only("constructor", "crititor", "stabilizer", "architect", "calibrator", "auditor", "supervisor", "challenger", "researcher")
        self.blob(d["source_blob"])
        if d.get("kind", "ADVISORY") == "ADVISORY":
            return {"advisory": self.create("advisory", dict(d, author=self.actor.record()))}
        if d.get("kind") != "MANDATORY_COUNTEREXAMPLE" or not d.get("counterexample_blob") or not d.get("target"):
            refuse("INVALID_COUNTEREXAMPLE", "Mandatory report requires a target and concrete counterexample")
        self.blob(d["counterexample_blob"])
        mission = d["mission"]
        root = self.optional("root", mission)
        obligations = d.get("obligations", [])
        tasks = d.get("tasks", [])
        for oid in obligations:
            if self.get("obligation", oid)["mission"] != mission:
                refuse("INVALID_SCOPE", "Counterexample obligation belongs elsewhere")
        for tid in tasks:
            if self.get("task", tid)["mission"] != mission:
                refuse("INVALID_SCOPE", "Counterexample task belongs elsewhere")
        if not obligations and not d.get("authority_span"):
            refuse("INVALID_SCOPE", "Reference an obligation or an omitted principal goal source span")
        if d.get("authority_span"):
            authority = self.get("authority", d["authority_span"]["authority"])
            intake_head = self.optional("intake_head", mission)
            expected_authority = root["authority"] if root else self.get("intake", intake_head["intake"])["authority"] if intake_head else None
            if expected_authority != authority["id"]:
                refuse("INVALID_SCOPE", "Source span belongs to another authority")
            raw = self.store.blobs.get(authority["source_blob"]).decode("utf-8")
            if d["authority_span"].get("quote", "") not in raw or not d["authority_span"].get("quote"):
                refuse("INVALID_SOURCE_SPAN", "Principal source quote does not resolve")
        lineage = root["lineage"] if root else mission
        targets = [(kind, row["data"]) for (kind, id), row in self.state.items()
                   if id == d["target"] and kind in ("task", "candidate", "bundle", "report", "obligation", "decision", "root", "plan")
                   and (not d.get("target_kind") or d["target_kind"] == kind)]
        if len(targets) != 1:
            refuse("INVALID_COUNTEREXAMPLE", "Counterexample must identify one existing target; name target_kind if ambiguous")
        target_kind, target = targets[0]
        if target.get("mission", target.get("id") if target_kind == "root" else None) != mission:
            refuse("INVALID_SCOPE", "Counterexample target belongs to another mission")
        target_digest = digest(target)
        fact = digest([lineage, sorted(obligations), d.get("authority_span"), target_kind, d["target"], target_digest, d["counterexample_blob"]])
        old = self.rows("case", fact=fact)
        if old:
            case = old[0]
            if self.actor.role == "auditor" and not case.get("audit") and not case.get("independent_final"):
                self.update("case", case["id"], audit=True, audit_stance="NEGATIVE")
                self.barrier(case, "PENDING_SCREEN")
                if case["status"] == "DISMISSED":
                    self.contest(self.get("case", case["id"]))
            return {"case": self.get("case", case["id"]), "duplicate": True}
        case = self.create("case", dict(mission=mission, lineage=lineage, fact=fact, target=d["target"], target_kind=target_kind, target_digest=target_digest,
                           source_blob=d["source_blob"], counterexample_blob=d["counterexample_blob"],
                           scope={"obligations": obligations, "tasks": tasks,
                                  "mission_wide": not tasks and not obligations},
                           status="REPORTED_PENDING_SCREEN", audit=self.actor.role == "auditor",
                           audit_stance="NEGATIVE" if self.actor.role == "auditor" else None,
                           established=False, independent_final=False, repairs=0), d.get("id"))
        self.barrier(case, "PENDING_SCREEN")
        self.job(case, "screen", 300)
        case = self.update("case", case["id"], review_head=review_basis(self.state, {"case": case["id"]})["head"])
        return {"case": case}

    def barrier(self, case, phase):
        self.put("barrier", case["id"], dict(case=case["id"], mission=case["mission"],
                 scope=case["scope"], phase=phase))
        self.bump(case["mission"])

    def job(self, case, kind, seconds):
        id = case["id"] + ":" + kind
        if self.optional("job", id):
            return self.get("job", id)
        return self.put("job", id, dict(case=case["id"], kind=kind, generation=1,
                        deadline=self.now + seconds, status="PENDING", target=case["target"]))

    def do_issue_screen(self, d):
        self.only("supervisor")
        case = self.get("case", d["case"])
        job = self.get("job", case["id"] + ":screen")
        if job["status"] != "PENDING" or self.now > job["deadline"]:
            refuse("STALE_REVIEW", "Screening job is no longer pending")
        if job.get("instance") and job["instance"] != self.actor.session:
            refuse("INDEPENDENCE_REQUIRED", "Only the assigned screening endpoint may decide")
        self.blob(d["source_blob"])
        self.charge(case["lineage"], "correction", 12)
        self.update("job", job["id"], status="COMPLETE")
        case = self.update("case", case["id"], screening_author=self.actor.record())
        if d["outcome"] == "ESTABLISHED":
            case = self.update("case", case["id"], status="ESTABLISHED", established=True,
                               screening_blob=d["source_blob"])
            self.barrier(case, "ESTABLISHED_HOLD")
        elif d["outcome"] == "DISMISSED":
            if case["audit"]:
                return self.contest(case, proposal="DISMISS_ORIGINAL")
            self.resolve(case, "DISMISSED", d["source_blob"])
        else:
            refuse("INVALID_VERDICT", "Screen outcome must be ESTABLISHED or DISMISSED")
        return {"case": self.get("case", case["id"])}

    def do_jobs_expire(self, d):
        self.only("controller", "pm")
        expired = []
        for job in self.rows("job"):
            if job["status"] in ("PENDING", "AWAIT_REPAIR") and self.now >= job["deadline"]:
                self.update("job", job["id"], status="EXPIRED")
                case = self.update("case", job["case"], status="UNRESOLVED_LIMIT")
                self.barrier(case, "SCREENING_UNAVAILABLE" if job["kind"] == "screen" else "UNRESOLVED_LIMIT")
                expired.append(job["id"])
        return {"expired": expired}

    def do_job_claim(self, d):
        self.only("controller")
        job = self.get("job", d["job"])
        case = self.get("case", job["case"])
        if job.get("occupied"):
            refuse("JOB_OCCUPIED", "The current generation already has an independent endpoint")
        if self.now >= job["deadline"]:
            refuse("STALE_REVIEW", "Expired jobs require bounded transport recovery")
        repair = d.get("repair")
        if job["status"] == "AWAIT_REPAIR" and repair is not None:
            contest = self.get("contest", case["id"])
            if contest["status"] != "UPHOLD" or contest["repair_checks"] >= 2:
                refuse("CONTEST_FINAL", "No independent repair compliance remains")
            self.verify_repair(case, dict(repair, counterexample_eliminated=True))
            for tid in repair.get("repair_tasks", []):
                permits = [p for p in self.rows("permit", case=case["id"]) if p["active"] and tid in p["tasks"]
                           and p["expires"] > self.now and p["authority_digest"] == self.authority_digest(case["mission"])]
                reports = self.rows("report", task=tid, kind="acceptance", outcome="ACCEPTED")
                if not permits or not reports or reports[-1]["created"] < permits[-1]["created"]:
                    refuse("REPAIR_NOT_VERIFIED", "Repair dispatch needs current accepted work under this case's recovery permission")
            job = self.update("job", job["id"], status="PENDING", phase="REPAIR_COMPLIANCE",
                              generation=job["generation"] + 1, deadline=self.now + 300,
                              repair=repair, instance=None)
        if job["status"] != "PENDING" or self.now >= job["deadline"]:
            refuse("STALE_REVIEW", "A finished or expired job cannot be dispatched")
        if job.get("failures", 0) >= 2:
            refuse("BUDGET_EXHAUSTED", "The bounded role transport retry has been used")
        session = "job-instance-" + uuid.uuid4().hex
        previous_reviewer = (self.optional("contest", case["id"]) or {}).get("reviewer") if job["kind"] == "contest" else None
        self.update("job", job["id"], instance=session, occupied=True,
                    reviewer_lineage=job.get("reviewer_lineage") or previous_reviewer or session,
                    attempts=job.get("attempts", 0) + 1)
        return {"job": self.get("job", job["id"]), "session": session,
                "role": "supervisor" if job["kind"] == "screen" else "stabilizer", "mission": case["mission"]}

    def do_job_unavailable(self, d):
        self.only("controller")
        job = self.get("job", d["job"])
        if job.get("instance") != d.get("instance") or job["generation"] != d.get("generation"):
            refuse("STALE_SESSION", "A retired endpoint cannot change job availability")
        if job["status"] == "PENDING":
            self.update("job", job["id"], status="UNAVAILABLE", occupied=False, failure=d["reason"], failures=job.get("failures", 0) + 1)
            case = self.update("case", job["case"], status="UNRESOLVED_LIMIT")
            self.barrier(case, "SCREENING_UNAVAILABLE")
        else:
            self.update("job", job["id"], occupied=False, transport_note=d["reason"])
        return {"job": self.get("job", job["id"])}

    def do_job_transport_finished(self, d):
        self.only("controller")
        job = self.get("job", d["job"])
        if job.get("instance") != d.get("instance") or job["generation"] != d.get("generation"):
            refuse("STALE_SESSION", "Only the occupying generation can retire its transport")
        if job["status"] == "PENDING":
            return self.do_job_unavailable(dict(d, reason="DRIVER_ENDED_WITHOUT_DECISION"))
        return {"job": self.update("job", job["id"], occupied=False)}

    def do_job_resume(self, d):
        self.only("controller", "pm")
        job = self.get("job", d["job"])
        if job["status"] not in ("UNAVAILABLE", "EXPIRED") or job.get("failures", 0) >= 2 or job.get("resumes", 0) >= 2:
            refuse("BUDGET_EXHAUSTED", "No bounded role transport recovery remains")
        self.update("job", job["id"], status="PENDING", occupied=False, instance=None, generation=job["generation"] + 1, resumes=job.get("resumes", 0) + 1, deadline=self.now + 300)
        case = self.get("case", job["case"])
        self.barrier(case, "PENDING_SCREEN" if job["kind"] == "screen" else "CONTEST_PENDING")
        return {"job": self.get("job", job["id"])}

    def contest(self, case, proposal=None):
        old = self.optional("contest", case["id"])
        if old:
            return {"contest": old, "reused": True}
        count = (self.optional("budget", case["lineage"] + ":correction") or {}).get("count", 0)
        if count >= 12:
            self.update("case", case["id"], status="UNRESOLVED_LIMIT")
            self.barrier(case, "UNRESOLVED_LIMIT")
            return {"blocked": "CONTEST_BUDGET_EXHAUSTED"}
        item = self.put("contest", case["id"], dict(case=case["id"], status="PENDING", proposal=proposal,
                         target=case["target"], reviewer=None, authority_digest=self.authority_digest(case["mission"])
                         if self.optional("root", case["mission"]) else None, repair_checks=0))
        self.update("case", case["id"], status="CONTESTED")
        self.barrier(case, "CONTEST_PENDING")
        self.job(case, "contest", 300)
        return {"contest": item}

    def do_case_contest(self, d):
        self.only("pm", "auditor", "constructor", "crititor", "stabilizer")
        return self.contest(self.get("case", d["case"]))

    def do_recovery_permit(self, d):
        self.only("pm")
        case = self.get("case", d["case"])
        if self.get("barrier", case["id"])["phase"] not in BLOCKED:
            refuse("CASE_NOT_ACTIVE", "Recovery requires an active scoped case")
        if case["repairs"] >= 2:
            refuse("BUDGET_EXHAUSTED", "Case repair cap reached")
        for tid in d["tasks"]:
            task = self.get("task", tid)
            self.grant(task["grant"], task["domain"], case["mission"])
            if task["mission"] != case["mission"] or not set(task["effects"]).issubset(task["allowed_effects"]):
                refuse("RECOVERY_SCOPE_CONFLICT", "Repair task is not authorized")
        self.update("case", case["id"], repairs=case["repairs"] + 1)
        permit = self.create("permit", dict(case=case["id"], mission=case["mission"], tasks=d["tasks"],
                               active=True, expires=self.now + min(d.get("seconds", 3600), 86400),
                               authority_digest=self.authority_digest(case["mission"])))
        return {"permit": permit}

    def resolve(self, case, status, source_blob):
        self.blob(source_blob)
        self.update("case", case["id"], status=status, resolution_blob=source_blob)
        self.barrier(case, "RELEASED")
        for permit in self.rows("permit", case=case["id"]):
            self.update("permit", permit["id"], active=False)

    def verify_repair(self, case, d):
        for tid in d.get("repair_tasks", []):
            task = self.get("task", tid)
            if task["mission"] != case["mission"]:
                refuse("REPAIR_NOT_VERIFIED", "Repair task belongs to another mission")
            self.grant(task["grant"], task["domain"], task["mission"])
            self.required_satisfied(task)
            self.task_acceptance(task)
            reports = self.rows("report", task=tid, kind="acceptance", outcome="ACCEPTED")
            if not reports or reports[-1]["target_digest"] != digest(task):
                refuse("REPAIR_NOT_VERIFIED", "Repair requires current independent product acceptance")
        if not d.get("repair_tasks") and not d.get("candidate"):
            refuse("REPAIR_NOT_VERIFIED", "Name the actual repair task or unactivated candidate")
        if d.get("candidate"):
            candidate = self.get("candidate", d["candidate"])
            intake = self.get("intake", candidate["intake"])
            authority = self.get("authority", candidate["authority"])
            reviews = self.rows("review", kind="root", target=candidate["id"], outcome="MATCH")
            if candidate["mission"] != case["mission"] or intake["candidate"] != candidate["id"] \
                    or self.get("intake_head", case["mission"])["intake"] != intake["id"] \
                    or not authority["active"] or not any(r["target_digest"] == digest(candidate)
                       and r["authority_digest"] == digest(authority) for r in reviews):
                refuse("REPAIR_NOT_VERIFIED", "Repair needs the current independently matched candidate and active authority")
        if not d.get("counterexample_eliminated"):
            refuse("REPAIR_NOT_VERIFIED", "Independent repair finding must address the original counterexample")

    def do_case_resolve(self, d):
        self.only("supervisor")
        case = self.get("case", d["case"])
        if case.get("independent_final"):
            refuse("CONTEST_FINAL", "A Supervisor cannot overwrite an independent final decision")
        self.blob(d["source_blob"])
        payload = {k: v for k, v in d.items() if k not in ("input_receipt", "review_basis")}
        dependencies = [r for r in d["review_basis"]["refs"] if r[0] not in ("case", "job")]
        if case["audit"] and (case.get("audit_agreement") != digest(payload)
                              or case.get("agreement_dependencies") != digest(dependencies)):
            return self.contest(case, proposal=d["outcome"])
        if d["outcome"] == "VERIFIED_FIXED":
            self.verify_repair(case, d)
        elif d["outcome"] == "AUTHORIZED_EXCEPTION":
            self.grant(d["grant"], d["domain"], case["mission"], permission="defer")
        elif d["outcome"] != "DISMISSED":
            refuse("INVALID_VERDICT", "Invalid resolution outcome")
        self.resolve(case, d["outcome"], d["source_blob"])
        return {"case": self.get("case", case["id"])}

    def do_audit_agree(self, d):
        self.only("auditor")
        case = self.get("case", d["case"])
        self.blob(d["source_blob"])
        payload = {k: v for k, v in d["resolution"].items() if k not in ("input_receipt", "review_basis")}
        dependencies = [r for r in d["review_basis"]["refs"] if r[0] not in ("case", "job")]
        self.update("case", case["id"], audit_agreement=digest(payload), audit_agreement_blob=d["source_blob"],
                    agreement_dependencies=digest(dependencies))
        return {"agreed": True}

    def do_contest_decide(self, d):
        self.only("stabilizer")
        case = self.get("case", d["case"])
        contest = self.get("contest", case["id"])
        job = self.get("job", case["id"] + ":contest")
        if job["status"] not in ("PENDING", "AWAIT_REPAIR") or self.now >= job["deadline"]:
            refuse("STALE_REVIEW", "Independent review job expired; use its bounded recovery")
        if job.get("instance") and job["instance"] != self.actor.session:
            refuse("INDEPENDENCE_REQUIRED", "Only the assigned independent job endpoint may decide")
        if self.actor.session == case["author"]["session"] or self.actor.session == (case.get("screening_author") or {}).get("session"):
            refuse("INDEPENDENCE_REQUIRED", "Contest needs a fresh independent instance")
        compliance = contest["status"] == "UPHOLD"
        reviewer = job.get("reviewer_lineage") or self.actor.session
        if contest.get("reviewer") and contest["reviewer"] != reviewer:
            refuse("INDEPENDENCE_REQUIRED", "Continue the same bounded independent instance after supplement or repair")
        if contest["status"] not in ("PENDING", "UPHOLD"):
            refuse("CONTEST_FINAL", "This case already has its independent final decision")
        if compliance:
            if contest["reviewer"] != reviewer or contest["repair_checks"] >= 2 or d["outcome"] != "REPAIR_VERIFIED":
                refuse("CONTEST_FINAL", "Only bounded repair compliance by the same independent instance is allowed")
            if job.get("repair") and any(d.get(key) != value for key, value in job["repair"].items()):
                refuse("REPAIR_NOT_VERIFIED", "Compliance must address the repair inputs assigned to this generation")
        self.blob(d["source_blob"])
        self.charge(case["lineage"], "correction", 12)
        outcome = d["outcome"]
        if outcome == "UPHOLD":
            self.update("case", case["id"], status="ESTABLISHED", established=True)
            self.barrier(case, "ESTABLISHED_HOLD")
        elif outcome == "REPAIR_VERIFIED":
            self.verify_repair(case, d)
            self.resolve(case, "VERIFIED_FIXED", d["source_blob"])
        elif outcome == "AUTHORIZED_EXCEPTION_VERIFIED":
            self.grant(d["grant"], d["domain"], case["mission"], permission="defer")
            self.resolve(case, "AUTHORIZED_EXCEPTION", d["source_blob"])
        elif outcome == "DISMISS_ORIGINAL":
            self.resolve(case, "DISMISSED", d["source_blob"])
            for latch in self.rows("latch", case=case["id"], active=True):
                self.update("latch", latch["id"], active=False, release_blob=d["source_blob"], independent_release=case["id"])
        elif outcome == "MODIFY_SCOPE":
            scope = d["scope"]
            if not set(scope.get("tasks", [])).issubset(case["scope"].get("tasks", [])) or not set(scope.get("obligations", [])).issubset(case["scope"].get("obligations", [])):
                refuse("INVALID_SCOPE", "Independent correction cannot silently expand the reported scope")
            case = self.update("case", case["id"], scope=scope, status="ESTABLISHED", established=True)
            self.barrier(case, "ESTABLISHED_HOLD")
        elif outcome == "INPUT_INCOMPLETE":
            self.charge(case["id"], "supplement", 1)
            self.update("case", case["id"], status="INPUT_INCOMPLETE")
            self.barrier(case, "SCREENING_UNAVAILABLE")
        else:
            refuse("INVALID_VERDICT", "Unsupported independent result")
        self.update("contest", case["id"], status="UPHOLD" if outcome == "MODIFY_SCOPE" else outcome, last_outcome=outcome, reviewer=reviewer,
                    decisions=contest.get("decisions", []) + [{"outcome": outcome, "endpoint": self.actor.session,
                        "generation": job["generation"], "review_basis": d["review_basis"], "source_blob": d["source_blob"]}],
                    repair_checks=contest["repair_checks"] + int(compliance), source_blob=d["source_blob"])
        self.update("case", case["id"], independent_final=outcome not in ("UPHOLD", "MODIFY_SCOPE", "INPUT_INCOMPLETE"))
        self.update("job", job["id"], status="AWAIT_REPAIR" if outcome in ("UPHOLD", "MODIFY_SCOPE") else "COMPLETE",
                    deadline=self.now + 86400 if outcome in ("UPHOLD", "MODIFY_SCOPE") else job["deadline"])
        return {"case": self.get("case", case["id"]), "supervisor_signature_required": False}

    def do_case_supplement(self, d):
        self.only("pm", "constructor", "auditor")
        case = self.get("case", d["case"])
        contest = self.get("contest", case["id"])
        if contest["status"] != "INPUT_INCOMPLETE":
            refuse("SUPPLEMENT_NOT_REQUESTED", "Independent reviewer must request the one bounded supplement")
        self.blob(d["source_blob"])
        self.update("case", case["id"], supplement_blob=d["source_blob"])
        self.update("contest", case["id"], status="PENDING")
        self.update("job", case["id"] + ":contest", status="PENDING", deadline=self.now + 300)
        self.barrier(case, "CONTEST_PENDING")
        return {"case": self.get("case", case["id"])}

    def do_rule_record(self, d):
        self.only("supervisor", "stabilizer")
        case = self.get("case", d["case"])
        if not case["established"] or not d.get("applicability") or not d.get("counterexamples"):
            refuse("RULE_INCOMPLETE", "A reusable rule needs an established case, applicability and counterexamples")
        return {"rule": self.create("rule", dict(lineage=case["lineage"], mission=case["mission"], case=case["id"],
                      applicability=d["applicability"], counterexamples=d["counterexamples"],
                      source_blob=self.blob(d["source_blob"]), active=True))}

    def do_rule_retire(self, d):
        self.only("supervisor", "stabilizer")
        self.blob(d["source_blob"])
        return {"rule": self.update("rule", d["rule"], active=False, retirement_blob=d["source_blob"])}

    def do_requirement_record(self, d):
        self.only("pm")
        task = self.get("task", d["task"])
        self.grant(task["grant"], task["domain"], task["mission"])
        from .process import validate_argv
        validate_argv(d["argv"])
        environment = self.get("environment", d["environment"])
        if environment.get("canonical"):
            canonical = environment["canonical"]
            required = canonical["required_inputs"] + ([canonical["compose_file"]] if canonical.get("compose_file") else [])
            if d["argv"] != ["{canonical}"] or not set(required).issubset(d["inputs"]):
                refuse("CANONICAL_PROFILE_MISMATCH", "Use the exact registered canonical command and all its fixed inputs")
        predicate = d.get("predicate", {"kind": "overall_pass"})
        if predicate.get("kind") not in ("overall_pass", "expected_negative", "check_set"):
            refuse("INVALID_PREDICATE", "Unknown verification success predicate")
        if predicate["kind"] == "expected_negative" and (not predicate.get("diagnostic") or not predicate.get("exit_code")):
            refuse("INVALID_PREDICATE", "Expected failure needs a specific nonzero exit and diagnostic")
        if predicate["kind"] == "check_set" and not predicate.get("checks"):
            refuse("INVALID_PREDICATE", "Check set cannot be empty")
        requirement = self.create("requirement", dict(task=d["task"], mission=task["mission"],
                                 argv=d["argv"], cwd=d.get("cwd", "."), inputs=d["inputs"],
                                 outputs=d.get("outputs", []),
                                 environment=d["environment"], predicate=predicate,
                                 scope=d.get("scope", "task"), required=d.get("required", True)), d.get("id"))
        self.update("task", task["id"], required_runs=task["required_runs"] + [requirement["id"]])
        return {"requirement": requirement}

    def do_environment_register(self, d):
        self.only("principal", "controller")
        from .environment import inspect_environment
        managed = (self.optional("config", "project") or {}).get("mode") == "managed"
        if managed:
            from .runner import inspect_managed_environment
            profile = inspect_managed_environment(d["executable"], None, [], [], d.get("values", {}), d.get("runtime_root"))
        else:
            profile = inspect_environment(d["executable"], d.get("cwd"), d.get("modules", []),
                                          d.get("project_modules", []), d.get("values", {}))
        expected = d.get("expected_version")
        if expected and profile["version"][:len(expected)] != expected:
            refuse("ENVIRONMENT_MISMATCH", "Selected interpreter differs from required canonical version")
        return {"environment": self.create("environment", dict(executable=d["executable"] if managed else profile["executable"],
                        runtime_root=d.get("runtime_root"),
                        version=profile["version"], modules=d.get("modules", []),
                        project_modules=d.get("project_modules", []), values=d.get("values", {}),
                        preflight_blob=self.store.blobs.put(__import__("json").dumps(profile).encode("utf-8"))), d.get("id"))}

    def do_canonical_register(self, d):
        self.only("principal", "controller")
        from .canonical import register
        profile = register(d, self.store.source_root, self.store.blobs)
        return {"environment": self.create("environment", dict(canonical=profile,
                    version=profile["expected_version"], values=profile["values"],
                    preflight_blob=profile["version_blob"]), d.get("id"))}

    def do_run_authorize(self, d):
        self.only("constructor", "crititor", "stabilizer", "controller")
        requirement = self.get("requirement", d["requirement"])
        if self.admission(d["admission"])["id"] != requirement["task"]:
            refuse("INVALID_SCOPE", "Execution admission belongs to another task")
        return {"authorized": True}

    def do_run_begin(self, d):
        self.only("constructor", "crititor", "stabilizer", "controller")
        requirement = self.get("requirement", d["requirement"])
        task = self.get("task", requirement["task"])
        if self.admission(d["admission"])["id"] != task["id"]:
            refuse("INVALID_SCOPE", "Execution admission belongs to another task")
        for sha in (d["source_blob"], d["environment_blob"], d["input_blob"]):
            self.blob(sha)
        key = digest([requirement, d["source_blob"], d["environment_blob"], d["input_blob"]])
        old = self.rows("run", key=key)
        latest = self.latest_attempt(requirement["id"])
        family = self.verification_family(requirement)
        related = [r for r in self.rows("run") if self.verification_family(self.get("requirement", r["requirement"])) == family]
        family_latest = max(related, key=lambda r: r.get("created", 0)) if related else None
        independent = d.get("purpose") == "independent_check"
        if latest and latest["status"] == "RUNNING" and latest["lease_until"] > self.now:
            return {"run": latest, "pending": True}
        if independent:
            if not d.get("reason"):
                refuse("INDEPENDENT_REASON_REQUIRED", "Independent rerun needs a concrete reason")
            self.charge(task.get("lineage", task["id"]), "independent_run", 2)
        else:
            for item in ([latest] if latest and latest["key"] == key else []):
                if item["status"] == "COMPLETE" and item["satisfied"] and item["assurance"] in ("controller-execution", "local-controlled-execution"):
                    self.blob(item["stdout_blob"])
                    try:
                        self.current_run(item, outputs=not (item.get("outputs_blob") and not self.rows("delivery", run=item["id"])))
                    except RuntimeRefusal as exc:
                        if exc.code not in ("STALE_EXECUTION_INPUT", "STALE_EXECUTION_OUTPUT", "EVIDENCE_UNAVAILABLE"):
                            raise
                    else:
                        return {"run": item, "reused": True}
                if item["status"] == "RUNNING" and item["lease_until"] > self.now:
                    return {"run": item, "pending": True}
        generation = max((x["generation"] for x in old), default=0) + 1
        if generation > 2 and not independent:
            refuse("BUDGET_EXHAUSTED", "Run takeover cap reached")
        if family_latest and (family_latest["status"] != "COMPLETE" or not family_latest["satisfied"]):
            self.charge(task.get("lineage", task["id"]), "run_recovery", 2)
        for item in self.rows("run", requirement=requirement["id"]):
            if item["status"] == "RUNNING":
                self.update("run", item["id"], status="EXPIRED", satisfied=False)
        deadline = self.now + min(float(d.get("deadline_seconds", 3600)), 86400)
        run = self.create("run", dict(key=key, requirement=requirement["id"], task=task["id"],
                         mission=task["mission"], status="RUNNING", satisfied=False,
                         source_blob=d["source_blob"], environment_blob=d["environment_blob"],
                         input_blob=d["input_blob"], admission=d["admission"], generation=generation,
                         attempt=(latest or {}).get("attempt", len(self.rows("run", requirement=requirement["id"]))) + 1,
                         lease_until=min(self.now + 300, deadline), deadline=deadline,
                         owner_session=self.actor.session, assurance="PENDING_EXECUTION"), d.get("id"))
        return {"run": run}

    def latest_attempt(self, requirement):
        runs = self.rows("run", requirement=requirement)
        return max(runs, key=lambda r: (r.get("attempt", 0), r.get("created", 0))) if runs else None

    def verification_family(self, requirement):
        task = self.get("task", requirement["task"])
        return digest([task.get("lineage", task["id"]), {k: requirement.get(k) for k in
                      ("argv", "cwd", "inputs", "environment", "predicate", "scope", "outputs", "required")}])

    def do_run_abort(self, d):
        self.only("controller")
        run = self.get("run", d["run"])
        for field in ("stdout_blob", "stderr_blob"):
            self.blob(d[field])
        if run["owner_session"] != self.actor.session or run["generation"] != d["generation"] or run["status"] != "RUNNING":
            return {"late_result": self.create("late_run_result", dict(d, status="LATE", satisfied=False))}
        return {"run": self.update("run", run["id"], status="TIMED_OUT" if d["code"] == "EXECUTION_TIMEOUT" else "EXECUTION_FAILED",
                    satisfied=False, assurance="controller-failure", failure_code=d["code"], failure_detail=d["detail"],
                    stdout_blob=d["stdout_blob"], stderr_blob=d["stderr_blob"], finished_at=self.now)}

    def do_run_heartbeat(self, d):
        run = self.get("run", d["run"])
        if run["owner_session"] != self.actor.session or run["generation"] != d["generation"] or run["status"] != "RUNNING":
            refuse("STALE_RUN_OWNER", "Run generation is not owned by this session")
        if self.now >= run["deadline"]:
            refuse("RUN_EXPIRED", "Total execution deadline has elapsed")
        self.update("run", run["id"], lease_until=min(self.now + 300, run["deadline"]))
        return {"run": self.get("run", run["id"])}

    def do_run_finish(self, d):
        self.only("constructor", "crititor", "stabilizer", "controller")
        run = self.get("run", d["run"])
        for sha in (d["stdout_blob"], d["stderr_blob"]):
            self.blob(sha)
        if run["owner_session"] != self.actor.session or run["generation"] != d["generation"] \
                or run["status"] != "RUNNING" or self.now > run["deadline"] or self.now > run["lease_until"]:
            if run["status"] == "RUNNING" and run["owner_session"] == self.actor.session and run["generation"] == d["generation"] and self.now > min(run["deadline"], run["lease_until"]):
                self.update("run", run["id"], status="EXPIRED", satisfied=False, failure_code="RUN_EXPIRED",
                            failure_detail="Execution deadline or lease elapsed", stdout_blob=d["stdout_blob"], stderr_blob=d["stderr_blob"])
            late = self.create("late_run_result", dict(d, status="LATE", satisfied=False))
            return {"late_result": late}
        req = self.get("requirement", run["requirement"])
        predicate = req["predicate"]
        result = d.get("result", "unknown")
        if predicate["kind"] == "overall_pass":
            satisfied = d["exit_code"] == 0 and result == "pass"
        elif predicate["kind"] == "expected_negative":
            log = self.store.blobs.get(d["stdout_blob"]) + self.store.blobs.get(d["stderr_blob"])
            satisfied = d["exit_code"] == predicate["exit_code"] and predicate["diagnostic"].encode("utf-8") in log
        else:
            checks = d.get("checks", {})
            satisfied = d["exit_code"] == 0 and all(checks.get(k) == v for k, v in predicate["checks"].items())
        assurance = ("controller-execution" if self.actor.authenticated else "local-controlled-execution") if self.actor.role == "controller" else "posthoc-declared"
        if req.get("outputs") and not d.get("outputs_blob"):
            satisfied = False
        if d.get("outputs_blob"):
            self.blob(d["outputs_blob"])
        execution_kind = "canonical_profile_execution" if self.get("environment", req["environment"]).get("canonical") else "frozen_input_execution"
        finished = self.update("run", run["id"], status="COMPLETE", stdout_blob=d["stdout_blob"],
                               stderr_blob=d["stderr_blob"], exit_code=d["exit_code"], result=result,
                               satisfied=satisfied, checks=d.get("checks", {}), assurance=assurance, execution_kind=execution_kind,
                               outputs_blob=d.get("outputs_blob"))
        return {"run": finished}

    def do_run_export(self, d):
        self.only("controller")
        run = self.get("run", d["run"])
        task = self.admission(run["admission"])
        if run["status"] != "COMPLETE" or not run["satisfied"]:
            refuse("OUTPUT_NOT_QUALIFIED", "Only successful controlled output can become a delivery")
        from .paths import resolve_ref, contained, relative_path
        from .storage import atomic_bytes
        import hashlib
        exported = []
        for item in d["outputs"]:
            path = resolve_ref(self.store.source_root, item["destination"])
            if path not in [resolve_ref(self.store.source_root, ref) for ref in task["outputs"]]:
                refuse("UNDECLARED_DELIVERY", "Execution output is outside reviewed delivery paths")
            from .paths import relative_path
            destination = relative_path(path, self.store.source_root).as_posix()
            if contained(path, self.store.path) or contained(path, self.store.source_root / ".claude") or contained(path, self.store.source_root / ".git"):
                refuse("PRIVATE_INPUT_FORBIDDEN", "Execution cannot export into private runtime state")
            current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
            if current != item.get("expected_sha256"):
                refuse("STALE_PRODUCT_HEAD", "Output destination changed during execution")
            self.blob(item["source_blob"])
            for old in self.rows("delivery", task=task["id"], path=destination, current=True):
                self.update("delivery", old["id"], current=False)
            exported.append(self.create("delivery", dict(task=task["id"], mission=task["mission"], run=run["id"],
                            path=destination, source_blob=item["source_blob"], current=True,
                            install_effect=True, previous_sha256=current)))
        return {"deliveries": exported}

    def required_satisfied(self, task):
        for rid in task["required_runs"]:
            requirement = self.get("requirement", rid)
            if not requirement["required"]:
                continue
            run = self.latest_attempt(rid)
            if not run or run["status"] != "COMPLETE" or not run["satisfied"]:
                refuse("REQUIRED_VERIFICATION_UNSATISFIED", "Required run is pending, failed, mixed, unknown or missing", requirement=rid)
            self.current_run(run)
            self.blob(run["stdout_blob"])
            self.blob(run["stderr_blob"])
            if run["assurance"] == "posthoc-declared":
                refuse("EXECUTION_ASSURANCE_REQUIRED", "A posthoc declaration is retained as history, not required execution proof")
            if (self.optional("config", "project") or {}).get("mode") == "managed" and run["assurance"] != "controller-execution":
                refuse("EXECUTION_ASSURANCE_REQUIRED", "Posthoc claims cannot satisfy managed required execution")

    def current_run(self, run, outputs=True):
        """Frozen bytes are reusable only while every declared input is still current."""
        import hashlib
        import json
        from .paths import resolve_ref
        root = getattr(self.store, "source_root", None)
        if root is None:
            refuse("SOURCE_ROOT_REQUIRED", "Positive verification requires the bound execution root")
        try:
            inputs = json.loads(self.store.blobs.get(run["input_blob"]).decode("utf-8"))
            if not isinstance(inputs, list):
                raise ValueError("manifest must be a list")
            for item in inputs:
                path = resolve_ref(root, item["path"], must_exist=True)
                if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != item["blob"]:
                    refuse("STALE_EXECUTION_INPUT", "Verification input bytes have changed", path=item["path"])
                self.blob(item["blob"])
            requirement = self.get("requirement", run["requirement"])
            profile = self.get("environment", requirement["environment"])
            environment = json.loads(self.store.blobs.get(run["environment_blob"]).decode("utf-8"))
            from pathlib import Path
            if profile.get("canonical"):
                from .canonical import executable_manifest
                canonical = profile["canonical"]
                actual = executable_manifest(canonical["executor_argv"], [x["path"] for x in canonical["executor_files"]], root)
                if environment.get("profile_digest") != digest(canonical) or actual != canonical["executor_files"]:
                    refuse("STALE_EXECUTION_ENVIRONMENT", "Canonical executor or profile changed")
            elif environment.get("runtime_sha256") != hashlib.sha256(Path(profile["executable"]).read_bytes()).hexdigest():
                refuse("STALE_EXECUTION_ENVIRONMENT", "Registered interpreter bytes changed")
            for module in environment.get("modules", {}).values():
                origin = module.get("origin")
                if not origin or origin.startswith(("/work/", "frozen-input-root/")):
                    continue
                if origin.startswith("/runtime/") and profile.get("runtime_root"):
                    origin = str(Path(profile["runtime_root"]) / origin[len("/runtime/"):])
                if module.get("sha256") and hashlib.sha256(Path(origin).read_bytes()).hexdigest() != module["sha256"]:
                    refuse("STALE_EXECUTION_ENVIRONMENT", "Imported dependency bytes changed")
            for item in requirement.get("outputs", []) if outputs else []:
                path = resolve_ref(root, item["destination"], must_exist=True)
                from .paths import relative_path
                deliveries = self.rows("delivery", run=run["id"], path=relative_path(path, root).as_posix(), current=True)
                if not deliveries or hashlib.sha256(path.read_bytes()).hexdigest() != deliveries[-1]["source_blob"]:
                    refuse("STALE_EXECUTION_OUTPUT", "Qualified execution output is missing or changed")
        except (ValueError, KeyError, OSError) as exc:
            refuse("STALE_EXECUTION_INPUT", "Verification manifest or current input is unavailable")

    def do_report_record(self, d):
        kind = d["kind"]
        allowed = {"development": "constructor", "critique": "crititor", "acceptance": "stabilizer"}
        if kind not in allowed:
            refuse("INVALID_REPORT_KIND", "Unknown task report kind")
        self.only(allowed[kind])
        task = self.get("task", d["task"])
        product_digest = digest(self.calibration_basis(task, reports=False))
        calibration = None
        self.blob(d["source_blob"])
        from .markdown import document_fields
        fields = document_fields(self.store.blobs.get(d["source_blob"]))
        parsed = fields["criteria"]["criteria"]
        if parsed:
            mapping = d.get("criteria_map", {key: key for key in parsed})
            if set(mapping) != set(parsed):
                refuse("CRITERIA_MAPPING_GAP", "Every written criteria row must map to its obligation")
            observed, order = {}, {"met": 2, "partial": 1, "missed": 0}
            for key, item in parsed.items():
                oid = mapping[key]
                observed[oid] = min(observed.get(oid, "met"), item["met"], key=order.get)
            if observed != d.get("criteria", {}):
                refuse("CRITERIA_SOURCE_CONFLICT", "Structured criteria cannot contradict or omit source-table rows")
        outcome = d["outcome"]
        allowed_outcomes = {"development": {"COMPLETE", "PARTIAL", "FAILED", "BLOCKED"},
                            "critique": {"PASS", "CHANGES_REQUESTED", "CHANGES-REQUESTED", "FAIL", "BLOCKED"},
                            "acceptance": {"ACCEPTED", "CHANGES_REQUESTED", "CHANGES-REQUESTED", "UNRESOLVED_LIMIT", "BLOCKED"}}
        if outcome not in allowed_outcomes[kind]:
            refuse("INVALID_VERDICT", "Outcome is not valid for this report role")
        positive = outcome in ("PASS", "ACCEPTED")
        development = None
        if positive:
            if self.admission(d["admission"])["id"] != task["id"]:
                refuse("INVALID_SCOPE", "Report admission belongs to another task")
            self.required_satisfied(task)
            developments = self.rows("report", task=task["id"], kind="development", current=True)
            if not developments or developments[-1]["target_digest"] != digest(task) or developments[-1].get("product_digest") != product_digest:
                refuse("CURRENT_DEVELOPMENT_REQUIRED", "Positive review needs the current actual development report")
            development = developments[-1]["id"]
            states = d.get("criteria", {})
            if set(states) != set(task["obligations"]) or any(s != "met" for s in states.values()):
                refuse("UNMET_OBLIGATION", "Positive report needs every required obligation actually met")
            if kind == "acceptance":
                if task.get("calibration_required") or self.get("admission", d["admission"]).get("permit") or d.get("round", 1) == 3:
                    calibration = self.current_calibration(task)["id"]
                critique = self.get("report", d["critique"])
                if critique["kind"] != "critique" or critique["outcome"] != "PASS" or critique["task"] != task["id"] \
                        or not critique["current"] or critique.get("development") != development \
                        or critique["target_digest"] != digest(task) or critique["author"]["session"] == self.actor.session:
                    refuse("CURRENT_INDEPENDENT_PASS_REQUIRED", "Acceptance requires a current independent PASS")
        previous = self.rows("report", task=task["id"], kind=kind, current=True)
        family = {t["id"] for t in self.rows("task") if t.get("lineage", t["id"]) == task.get("lineage", task["id"])}
        prior_rounds = [r for r in self.rows("report", kind="development") if r["task"] in family]
        maximum = max([r["round"] for r in prior_rounds] + [0])
        requested_round = d.get("round", 1)
        if not isinstance(requested_round, int) or requested_round < 1 or requested_round > 3:
            refuse("ROUND_CAP", "Product rounds must stay within the admitted cap of three")
        if kind == "development" and requested_round > maximum + 1:
            refuse("ROUND_SEQUENCE", "Product rounds cannot be skipped")
        if previous and requested_round < previous[-1]["round"]:
            refuse("ROUND_SEQUENCE", "A revision cannot reset its lineage round")
        if previous:
            if d.get("revises") != previous[-1]["id"]:
                refuse("STALE_HEAD", "Report must identify its current predecessor across rounds")
            if requested_round == previous[-1]["round"]:
                prior = previous[-1]
                if any(prior.get(key) != value for key, value in {"source_blob":d["source_blob"], "criteria":d.get("criteria", {}),
                       "outcome":outcome, "target_digest":digest(task), "product_digest": product_digest}.items()):
                    refuse("SUBSTANTIVE_REVISION_REQUIRES_ROUND", "A changed source, criterion, outcome or product needs the next bounded round")
                annotation = self.create("report_annotation", dict(report=prior["id"], mission=task["mission"],
                            source_blob=self.blob(d.get("annotation_blob", d["source_blob"]))))
                if kind == "acceptance" and calibration:
                    self.put("acceptance_qualification", prior["id"], {"calibration": calibration, "report": prior["id"],
                             "source_blob": d["source_blob"], "author": self.actor.record()})
                return {"report": prior, "annotation": annotation, "metadata_only": True}
            self.update("report", previous[-1]["id"], current=False)
        elif kind == "development" and prior_rounds and requested_round <= maximum:
            refuse("ROUND_SEQUENCE", "A replacement task inherits the product lineage round budget")
        report = self.create("report", dict(task=task["id"], mission=task["mission"], kind=kind,
                            outcome=outcome, source_blob=d["source_blob"], target_digest=digest(task),
                            product_digest=product_digest, calibration=calibration,
                            criteria=d.get("criteria", {}), current=True, revises=d.get("revises"),
                            round=d.get("round", 1), admission=d.get("admission"), source_fields=fields), d.get("id"))
        for section, items in fields["lists"].items():
            for item in items:
                if "relay" in section.lower() or "engine" in section.lower():
                    self.create("relay_item", dict(mission=task["mission"], report=report["id"],
                                text=item["text"], source_blob=d["source_blob"], source_span=[item["start_line"], item["end_line"]]))
                elif "noticed" in section.lower() or "out-of-frame" in section.lower():
                    matches = [flag for flag in self.rows("flag", mission=task["mission"], live=True)
                               if flag.get("origin_task") == task["id"] and flag["text"] == item["text"]]
                    if item["text"].startswith("carried: flag:"):
                        flag = self.get("flag", item["text"].split("carried: flag:", 1)[1].strip())
                        if flag["mission"] != task["mission"] or not flag["live"]:
                            refuse("INVALID_CARRIED_FLAG", "Carried flag is not live in this mission")
                    elif not matches:
                        self.create("flag", dict(mission=task["mission"], origin_task=task["id"], text=item["text"],
                                    source_blob=d["source_blob"], source_span=[item["start_line"], item["end_line"]],
                                    status="OPEN", live=True, disposition=None))
        if positive:
            report = self.update("report", report["id"], development=development, critique=d.get("critique"))
        if outcome == "ACCEPTED":
            for oid in task["obligations"]:
                self.update("obligation", oid, status="MET", evidence=report["id"])
        return {"report": report}

    def task_acceptance(self, task):
        accepted = self.rows("report", task=task["id"], kind="acceptance", outcome="ACCEPTED", current=True)
        if not accepted or accepted[-1]["target_digest"] != digest(task):
            refuse("CURRENT_ACCEPTANCE_REQUIRED", "Task has no current independent acceptance")
        report = accepted[-1]
        critique = self.get("report", report["critique"])
        development = self.get("report", report["development"])
        if not critique["current"] or critique["outcome"] != "PASS" or not development["current"] or critique.get("development") != development["id"]:
            refuse("STALE_DEPENDENCY", "Accepted review depends on a replaced development report or critique")
        current_product = digest(self.calibration_basis(task, reports=False))
        if any(r.get("product_digest") != current_product for r in (report, critique, development)):
            refuse("STALE_DEPENDENCY", "Accepted review describes a different actual product, run or applicable authority")
        if task.get("calibration_required") or report.get("calibration") or report["round"] == 3 or (self.optional("admission", report.get("admission")) or {}).get("permit"):
            cell_id = (self.optional("acceptance_qualification", report["id"]) or {}).get("calibration", report.get("calibration"))
            self.current_calibration(task, cell_id)
        return report

    def calibration_basis(self, task, reports=True):
        """Product dependencies exclude acceptance/obligation bookkeeping and other tasks."""
        import hashlib
        from .paths import resolve_ref, contained
        authority = self.get("authority", self.get("root", task["mission"])["authority"])
        decisions = [x for x in self.rows("decision", mission=task["mission"], current=True)
                     if self.decision_applies(x, task)]
        requirements, runs, paths = [], [], list(task.get("outputs", []))
        for rid in task["required_runs"]:
            req = self.get("requirement", rid)
            if not req["required"]:
                continue
            profile = self.get("environment", req["environment"])
            requirements.append([req, profile])
            paths += req.get("inputs", [])
            run = self.latest_attempt(rid)
            runs.append(run)
        files = []
        for ref in paths:
            path = resolve_ref(self.store.source_root, ref)
            if any(contained(path, private) for private in (self.store.path, self.store.source_root / ".claude", self.store.source_root / ".git")):
                refuse("PRIVATE_INPUT_FORBIDDEN", "Calibration cannot inspect private state as product input")
            files.append([ref, hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() and not path.is_symlink() else None])
        result = {"task": task, "authority": authority, "grant": self.get("grant", task["grant"]),
                  "contracts": applicable_contracts(self.state, task["mission"]), "decisions": decisions,
                  "requirements": requirements, "runs": runs, "files": files,
                  "deliveries": self.rows("delivery", task=task["id"], current=True)}
        if reports:
            result["reports"] = [x for x in self.rows("report", task=task["id"], current=True) if x["kind"] in ("development", "critique")]
        return result

    def current_calibration(self, task, cell_id=None):
        self.required_satisfied(task)
        basis = self.calibration_basis(task)
        if any(run is None or run["status"] != "COMPLETE" or not run["satisfied"] for run in basis["runs"]):
            refuse("TASK_CALIBRATION_REQUIRED", "Current required execution is not yet qualified for calibration")
        cells = self.rows("calibration", mission=task["mission"], task=task["id"], outcome="ALIGNED")
        matching = [c for c in cells if (cell_id is None or c["id"] == cell_id) and c.get("dependency_digest") == digest(basis)]
        if not matching:
            refuse("TASK_CALIBRATION_REQUIRED", "No ALIGNED cell read this current product/run/report/authority dependency set")
        return matching[-1]

    def do_obligation_defer(self, d):
        self.only("pm")
        ob = self.get("obligation", d["obligation"])
        self.grant(d["grant"], d["domain"], ob["mission"], permission="defer")
        if not d.get("owner") or not d.get("reason_blob"):
            refuse("DEFERRAL_INCOMPLETE", "Authorized deferral needs responsibility and an explicit reason")
        self.blob(d["reason_blob"])
        self.update("obligation", ob["id"], status="AUTHORIZED_DEFERRED", grant=d["grant"],
                    domain=d["domain"],
                    deferred_owner=d["owner"], reason_blob=d["reason_blob"], verified_fixed=False)
        return {"obligation": self.get("obligation", ob["id"])}

    def do_flag_raise(self, d):
        self.blob(d["source_blob"])
        return {"flag": self.create("flag", dict(mission=d["mission"], text=d["text"], source_blob=d["source_blob"],
                               status="OPEN", live=True, disposition=None), d.get("id"))}

    def do_flag_change(self, d):
        self.only("pm")
        flag = self.get("flag", d["flag"])
        self.grant(d["grant"], d["domain"], flag["mission"], permission="revise")
        operation = d["operation"]
        if not d.get("reason_blob"):
            refuse("REASON_REQUIRED", "Explicit flag transition needs a reason")
        self.blob(d["reason_blob"])
        if operation == "reopen":
            self.update("flag", flag["id"], status="OPEN", live=True, disposition=None, superseded_by=None)
        elif operation == "retire":
            self.update("flag", flag["id"], status="RETIRED", live=False, reason_blob=d["reason_blob"])
        elif operation == "replace":
            other = self.get("flag", d["replacement"])
            if other["mission"] != flag["mission"] or other["id"] == flag["id"] or not other["live"]:
                refuse("INVALID_REPLACEMENT", "Flag replacement must be another live flag in this mission")
            self.update("flag", flag["id"], status="REPLACED", live=False, superseded_by=other["id"])
        elif operation == "dispose":
            if d["disposition"] not in ("FIXED", "AUTHORIZED_DEFERRED", "ACCEPTED_RISK", "DUPLICATE", "NOT_APPLICABLE"):
                refuse("INVALID_DISPOSITION", "Name an explicit product disposition")
            if d["disposition"] in ("AUTHORIZED_DEFERRED", "ACCEPTED_RISK"):
                self.grant(d["grant"], d["domain"], flag["mission"], permission="defer")
            if d["disposition"] == "FIXED":
                report = self.get("report", d["evidence"])
                task = self.get("task", report["task"])
                self.required_satisfied(task)
                if self.task_acceptance(task)["id"] != report["id"]:
                    refuse("REPAIR_NOT_VERIFIED", "Fixed disposition must cite current accepted product evidence")
            self.update("flag", flag["id"], status="DISPOSED", disposition=d["disposition"], reason_blob=d["reason_blob"])
        else:
            refuse("INVALID_FLAG_OPERATION", "Use retire, replace, reopen or dispose")
        return {"flag": self.get("flag", flag["id"])}

    def do_bundle_record(self, d):
        self.only("controller", "pm")
        self.get("root", d["mission"])
        root = self.get("root", d["mission"])
        required = {}
        from .contracts import required_records
        for kind, value in required_records(self.state, d["mission"]):
            if value.get("source_blob"):
                required[value["source_blob"]] = {"blob": value["source_blob"], "path": kind + ":" + value["id"]}
        included_kinds = {"authority", "grant", "candidate", "task", "decision", "report", "run", "delivery", "obligation"}
        def collect(value, path):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.endswith("_blob") and isinstance(child, str):
                        required[child] = {"blob": child, "path": path + "/" + key}
                    elif key == "inputs" and isinstance(child, list):
                        for ref in child:
                            if isinstance(ref, str) and len(ref) == 64:
                                required[ref] = {"blob": ref, "path": path + "/inputs"}
                    else:
                        collect(child, path + "/" + key)
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    collect(child, path + "/" + str(index))
        for (kind, id), row in self.state.items():
            value = row["data"]
            if kind not in included_kinds:
                continue
            relevant = value.get("mission") == d["mission"] or (kind == "authority" and id == root["authority"]) or (kind == "grant" and value.get("authority") == root["authority"])
            if relevant:
                collect(value, kind + ":" + id)
                if kind == "run":
                    import json
                    for item in json.loads(self.store.blobs.get(value["input_blob"])):
                        required[item["blob"]] = {"blob": item["blob"], "path": "run:" + id + "/input/" + item["path"]}
        # Adopted legacy evidence is part of what this closure delivers, and keeps
        # its own name even when a v4 record cites the same bytes.
        for scope in self.rows("legacy_scope", mission=d["mission"]):
            for aid in scope.get("artifacts", []):
                overlay = self.optional("semantic_overlay", aid) or {}
                if overlay.get("source_blob"):
                    required[overlay["source_blob"]] = {"blob": overlay["source_blob"], "path": "legacy:" + str(aid)}
        for task in self.rows("task", mission=d["mission"]):
            for output in task.get("outputs", []):
                deliveries = self.rows("delivery", task=task["id"], path=output, current=True)
                if not deliveries:
                    refuse("INPUT_INCOMPLETE", "Declared delivery output has no immutable snapshot", path=output)
        items, unavailable = [], []
        for item in list(required.values()) + d.get("items", []):
            try:
                self.blob(item["blob"])
                items.append(item)
            except RuntimeRefusal:
                unavailable.append(item.get("path", item.get("blob")))
        bundle = self.create("bundle", dict(mission=d["mission"], target=d["target"], items=items,
                            unavailable=unavailable, authority_digest=self.authority_digest(d["mission"]),
                            delivery_digest=self.delivery_digest(d["mission"]),
                            calibration_dependencies={t["id"]: digest(self.calibration_basis(t)) for t in self.rows("task", mission=d["mission"])},
                            status="INPUT_INCOMPLETE" if unavailable else "READY"), d.get("id"))
        return {"bundle": bundle}

    def delivery_digest(self, mission):
        kinds = {"root", "task", "obligation", "decision", "delivery", "report", "run", "flag"}
        return digest([[kind, id, row["data"]] for (kind, id), row in sorted(self.state.items())
                       if kind in kinds and (row["data"].get("mission") == mission or (kind == "root" and id == mission))])

    def current_bundle(self, bundle):
        if bundle.get("delivery_digest") != self.delivery_digest(bundle["mission"]):
            refuse("STALE_BUNDLE", "Actual delivery or its qualified evidence has changed")
        import hashlib
        from .paths import resolve_ref
        for delivery in self.rows("delivery", mission=bundle["mission"], current=True):
            source = resolve_ref(self.store.source_root, delivery["path"], must_exist=True)
            if hashlib.sha256(source.read_bytes()).hexdigest() != delivery["source_blob"]:
                refuse("STALE_BUNDLE", "Delivered bytes have changed", path=delivery["path"])

    def do_delivery_record(self, d):
        self.only("constructor")
        task = self.get("task", d["task"])
        if self.admission(d["admission"])["id"] != task["id"]:
            refuse("INVALID_SCOPE", "Delivery admission belongs to another task")
        if d["path"] not in task.get("outputs", []):
            refuse("UNDECLARED_DELIVERY", "Delivery must be one of the task's reviewed output paths")
        for old in self.rows("delivery", task=task["id"], path=d["path"], current=True):
            self.update("delivery", old["id"], current=False)
        return {"delivery": self.create("delivery", dict(task=task["id"], mission=task["mission"],
                        path=d["path"], source_blob=self.blob(d["source_blob"]), current=True))}

    def do_work_write(self, d):
        self.only("constructor")
        task = self.get("task", d["task"])
        if self.admission(d["admission"])["id"] != task["id"] or d["path"] not in task.get("write_paths", []):
            refuse("WRITE_SCOPE_CONFLICT", "Product write is outside the reviewed task paths")
        from .paths import resolve_ref, contained
        from .storage import atomic_bytes
        path = resolve_ref(self.store.source_root, d["path"])
        if contained(path, self.store.path) or contained(path, self.store.source_root / ".claude") or contained(path, self.store.source_root / ".git"):
            refuse("PRIVATE_INPUT_FORBIDDEN", "Roles cannot write pipeline private state")
        import hashlib
        current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
        if d.get("expected_sha256") != current:
            refuse("STALE_PRODUCT_HEAD", "Working file changed; re-read before replacing it")
        raw = self.store.blobs.get(d["source_blob"])
        if len(raw) > 8 * 1024 * 1024:
            refuse("INVALID_INPUT", "A scoped write exceeds the tool size limit")
        return {"write": self.create("work_change", dict(task=task["id"], mission=task["mission"],
                       path=d["path"], previous_sha256=current, source_blob=d["source_blob"], install_effect=True))}

    def do_calibration_record(self, d):
        self.only("calibrator", "stabilizer")
        bundle = self.get("bundle", d["bundle"])
        if not isinstance(d["wave"], int) or d["wave"] < 1:
            refuse("INVALID_WAVE", "Calibration needs a positive wave number")
        self.get("wave", bundle["mission"] + ":" + str(d["wave"]))
        if d.get("task"):
            task = self.get("task", d["task"])
            if task["mission"] != bundle["mission"] or task["wave"] != d["wave"]:
                refuse("INVALID_SCOPE", "Task calibration must match its mission and wave")
            if bundle.get("calibration_dependencies", {}).get(task["id"]) != digest(self.calibration_basis(task)):
                refuse("STALE_BUNDLE", "This task's actual calibration inputs have changed")
            if d["outcome"] == "ALIGNED":
                self.required_satisfied(task)
                if any(r is None or r["status"] != "COMPLETE" or not r["satisfied"] for r in self.calibration_basis(task)["runs"]):
                    refuse("TASK_CALIBRATION_REQUIRED", "ALIGNED needs current completed execution")
        self.current_bundle(bundle)
        if d["outcome"] not in ("ALIGNED", "SUSPICION", "DRIFT", "INPUT_INCOMPLETE"):
            refuse("INVALID_VERDICT", "Invalid calibration outcome")
        if bundle["status"] != "READY" and d["outcome"] != "INPUT_INCOMPLETE":
            refuse("INPUT_INCOMPLETE", "Missing actual delivery inputs cannot be called aligned")
        if bundle["authority_digest"] != self.authority_digest(bundle["mission"]):
            refuse("STALE_BUNDLE", "Calibration authority has changed")
        self.blob(d["source_blob"])
        item = self.create("calibration", dict(mission=bundle["mission"], wave=d["wave"],
                           task=d.get("task"), task_digest=digest(self.get("task", d["task"])) if d.get("task") else None,
                           dependency_digest=digest(self.calibration_basis(task)) if d.get("task") else None,
                           bundle=bundle["id"], outcome=d["outcome"], source_blob=d["source_blob"]), d.get("id"))
        trigger = d["outcome"] == "DRIFT"
        if not d.get("task") and d["outcome"] == "SUSPICION":
            aggregates = self.rows("calibration", mission=bundle["mission"], task=None)
            bywave = {}
            for verdict in sorted(aggregates, key=lambda x: x["created"]):
                bywave[verdict["wave"]] = verdict
            waves = [bywave[number] for number in sorted(bywave)]
            trigger = len(waves) >= 2 and waves[-1]["wave"] == waves[-2]["wave"] + 1 and all(x["outcome"] == "SUSPICION" for x in waves[-2:])
        if trigger:
            obligations = self.get("task", d["task"])["obligations"] if d.get("task") else [o["id"] for o in self.rows("obligation", mission=bundle["mission"])]
            issue = self.do_issue_report(dict(kind="MANDATORY_COUNTEREXAMPLE", mission=bundle["mission"],
                        source_blob=d["source_blob"], counterexample_blob=d["source_blob"], target=bundle["id"],
                        tasks=[d["task"]] if d.get("task") else [], obligations=obligations))
            self.create("latch", dict(mission=bundle["mission"], trigger=item["id"], active=True,
                        tasks=[d["task"]] if d.get("task") else [], case=issue["case"]["id"], source_blob=d["source_blob"]))
            self.bump(bundle["mission"])
        return {"calibration": item}

    def do_latch_release(self, d):
        self.only("principal", "stabilizer")
        latch = self.get("latch", d["latch"])
        self.blob(d["source_blob"])
        if self.actor.role == "stabilizer":
            contest = self.get("contest", d["contest"])
            if contest["status"] != "DISMISS_ORIGINAL" or contest["reviewer"] != self.actor.session:
                refuse("AUTHORITY_CONFLICT", "Only an independent false-drift finding can release without principal")
            if latch.get("case") != contest["case"]:
                refuse("INVALID_SCOPE", "Contest does not adjudicate this latch")
        self.update("latch", latch["id"], active=False, release_blob=d["source_blob"])
        self.bump(latch["mission"])
        return {"latch": self.get("latch", latch["id"])}

    def do_audit_record(self, d):
        self.only("auditor")
        bundle = self.get("bundle", d["bundle"])
        self.current_bundle(bundle)
        if bundle["status"] != "READY":
            refuse("INPUT_INCOMPLETE", "Closure audit requires actual complete inputs")
        self.blob(d["source_blob"])
        findings = []
        for finding in d.get("findings", []):
            issue = self.do_issue_report(dict(finding, mission=bundle["mission"]))
            findings.append(issue.get("case", issue.get("advisory"))["id"])
        audit = self.create("audit", dict(mission=bundle["mission"], bundle=bundle["id"], findings=findings,
                           source_blob=d["source_blob"], authority_digest=self.authority_digest(bundle["mission"]),
                           status="COMPLETE"), d.get("id"))
        return {"audit": audit}

    def do_close_review(self, d):
        self.only("supervisor")
        bundle = self.get("bundle", d["bundle"])
        self.current_bundle(bundle)
        self.blob(d["source_blob"])
        if bundle["status"] != "READY":
            refuse("INPUT_INCOMPLETE", "Closure review needs actual inputs")
        review = self.create("review", dict(kind="close", target=bundle["id"], target_digest=digest(bundle),
                              authority_digest=self.authority_digest(bundle["mission"]), outcome=d["outcome"],
                              source_blob=d["source_blob"]), d.get("id"))
        return {"review": review}

    def do_mission_close(self, d):
        self.only("pm", "principal")
        mission = d["mission"]
        root = self.get("root", mission)
        self.qualify(mission, closing=True)
        for obligation in self.rows("obligation", mission=mission):
            if obligation["status"] not in ("MET", "AUTHORIZED_DEFERRED", "AUTHORIZED_CANCELLED"):
                refuse("UNMET_OBLIGATION", "Mission has an unmet required outcome", obligation=obligation["id"])
            if obligation["status"] in ("AUTHORIZED_DEFERRED", "AUTHORIZED_CANCELLED"):
                self.grant(obligation["grant"], obligation["domain"], mission, permission="defer")
        for task in self.rows("task", mission=mission):
            if task["status"] == "REPLACED":
                continue
            accepted = self.rows("report", task=task["id"], kind="acceptance", outcome="ACCEPTED", current=True)
            excepted = all(self.get("obligation", oid)["status"] in ("AUTHORIZED_DEFERRED", "AUTHORIZED_CANCELLED")
                           for oid in task["obligations"])
            if not excepted:
                self.required_satisfied(task)
                self.task_acceptance(task)
            if not excepted and not any(r["target_digest"] == digest(task) for r in accepted):
                refuse("UNFINISHED_TASK", "Every required task needs current acceptance or authorized disposition")
        for flag in self.rows("flag", mission=mission):
            if flag["live"] and flag["status"] == "OPEN":
                refuse("OPEN_FLAG", "A live product flag has no disposition")
        bundle = self.get("bundle", d["bundle"])
        self.current_bundle(bundle)
        audit = self.get("audit", d["audit"])
        review = self.get("review", d["review"])
        current_auth = self.authority_digest(mission)
        if bundle["mission"] != mission or audit["bundle"] != bundle["id"] or audit["authority_digest"] != current_auth \
                or review["kind"] != "close" or review["target"] != bundle["id"] or review["outcome"] != "PASS" \
                or review["target_digest"] != digest(bundle) or review["authority_digest"] != current_auth:
            refuse("CLOSURE_REVIEW_REQUIRED", "Current mandatory Auditor and Supervisor closure reviews are required")
        run = self.get("run", d["closing_run"])
        req = self.get("requirement", run["requirement"])
        if run["mission"] != mission or req["scope"] != "closing" or not run["satisfied"] or run["status"] != "COMPLETE":
            refuse("CLOSING_RUN_UNSATISFIED", "A completed successful canonical closing run is required")
        self.current_run(run)
        if self.actor.role != "principal":
            self.grant(d["grant"], d["domain"], mission, permission="close")
        self.blob(d["source_blob"])
        self.update("root", mission, status="CLOSED", closing_blob=d["source_blob"])
        return {"mission": mission, "status": "CLOSED", "outcomes": self.rows("obligation", mission=mission)}

    def do_mission_reopen(self, d):
        self.only("principal")
        root = self.get("root", d["mission"])
        if root["status"] != "CLOSED":
            refuse("MISSION_NOT_CLOSED", "Only a closed mission needs a reopening decision")
        self.blob(d["source_blob"])
        self.bump(d["mission"])
        return {"root": self.update("root", d["mission"], status="OPEN", reopen_blob=d["source_blob"])}
