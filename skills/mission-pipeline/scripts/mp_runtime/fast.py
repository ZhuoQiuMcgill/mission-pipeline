"""Receipt routing and delegated coordination over the existing journal.

Inspection is pure: qualification never expires a job, opens a case or writes a
queue. Human judgments remain independent submissions, not inferred by code.
"""
import hashlib
import time

from .process import RuntimeRefusal
from .storage import digest, json_bytes


def fail(code, message, **fields):
    raise RuntimeRefusal(code, message, **fields)


def routed(task):
    return task.get("workflow_policy") in ("fast", "exploration")


def path_key(root, ref):
    """Compare strings and typed PathRefs by their resolved product location."""
    from .paths import relative_path, resolve_ref
    return relative_path(resolve_ref(root, ref), root).as_posix().casefold()


class ReceiptWorkflow:
    def path_keys(self, refs):
        return {path_key(self.store.source_root, ref) for ref in refs}

    def delegation_authority(self, mission, decision):
        from .contracts import applicable_contracts
        root = self.get("root", mission)
        return digest([self.get("authority", root["authority"]), root.get("version"),
                       self.get("grant", decision["grant"]), applicable_contracts(self.state, mission)])

    def receipt_authority(self, task):
        from .contracts import applicable_contracts
        root = self.get("root", task["mission"])
        decisions = [d for d in self.rows("decision", mission=task["mission"], current=True)
                     if self.decision_applies(d, task) or d["id"] in task.get("decision_dependencies", [])]
        grants = {task["grant"]} | {d["grant"] for d in decisions}
        return digest([self.get("authority", root["authority"]),
                       {k: root.get(k) for k in ("version", "authority", "candidate")},
                       applicable_contracts(self.state, task["mission"]), decisions,
                       [self.get("grant", gid) for gid in sorted(grants)]])

    def contract(self, task):
        requirements = []
        for rid in task["required_runs"]:
            req = self.optional("requirement", rid)
            if not req or req["task"] != task["id"]:
                fail("VERIFICATION_DEFINITION_REQUIRED", "Define every check before reviewing the executable receipt", requirement=rid)
            requirements.append([req, self.get("environment", req["environment"])])
            if routed(task):
                worker = next((w for w in task.get("workers", []) if w["id"] == req.get("worker")), None)
                if not worker:
                    fail("VERIFICATION_WORKER_REQUIRED", "Assign every executable check to a worker", requirement=rid)
                if not self.path_keys(o["destination"] for o in req.get("outputs", [])).issubset(self.path_keys(worker.get("outputs", []))):
                    fail("WORKER_SCOPE", "Verification output destinations must belong to their assigned worker")
        if routed(task) and task.get("work_type") != "milestone":
            if not task.get("criteria") or not task.get("workers"):
                fail("INCOMPLETE_RECEIPT", "An executable receipt needs criteria and worker assignments")
            if not set(task["obligations"]).issubset(task["criteria"]):
                fail("CRITERIA_MAPPING_GAP", "Receipt criteria must cover its obligations")
        from .workflow import OBLIGATION_DISPOSITION
        bookkeeping = set(OBLIGATION_DISPOSITION) | {"status", "deferred_by", "owner"}
        obligations = [{k: v for k, v in self.get("obligation", oid).items() if k not in bookkeeping}
                       for oid in task["obligations"]]
        return {"task": task, "verification": requirements, "obligations": obligations}

    def graph_check(self, tasks):
        def walk(task, visiting):
            if task["id"] in visiting:
                fail("DEPENDENCY_CYCLE", "Task graph contains a cycle")
            for tid in task.get("dependencies", []):
                other = self.get("task", tid)
                if other["mission"] != task["mission"]:
                    fail("CROSS_MISSION_REFERENCE", "Graph edges must stay inside a mission")
                walk(other, visiting | {task["id"]})
            for did in task.get("decision_dependencies", []):
                other = self.optional("decision", did)
                if other and other["mission"] != task["mission"]:
                    fail("CROSS_MISSION_REFERENCE", "Decision dependency belongs to another mission")
        for task in tasks:
            walk(task, set())
            parents, node = {task["id"]}, task
            while node.get("parent"):
                node = self.get("task", node["parent"])
                if node["id"] in parents:
                    fail("PARENT_CYCLE", "Parent task hierarchy contains a cycle")
                if node["mission"] != task["mission"]:
                    fail("CROSS_MISSION_REFERENCE", "Parent belongs to another mission")
                parents.add(node["id"])

    def task_fields(self, d, previous):
        if "work_type" not in d and not routed(previous or {}):
            return {}
        kind = d.get("work_type", (previous or {}).get("work_type"))
        if kind not in ("execution", "exploration", "milestone"):
            fail("INVALID_WORK_TYPE", "Subtasks are execution, exploration or milestone")
        policy = "fast" if kind == "execution" else "exploration"
        workers = d.get("workers", [])
        from .paths import resolve_ref, contained
        occupied, worker_ids = set(), set()
        for worker in workers:
            if not worker.get("id") or worker["id"] in worker_ids:
                fail("INVALID_WORKER", "Workers need distinct stable ids")
            worker_ids.add(worker["id"])
            for ref in worker.get("write_paths", []) + worker.get("outputs", []):
                path = resolve_ref(self.store.source_root, ref)
                if any(contained(path, p) for p in (self.store.path, self.store.source_root / ".claude", self.store.source_root / ".git")):
                    fail("PRIVATE_INPUT_FORBIDDEN", "Worker scope includes private runtime state")
            paths = {str(resolve_ref(self.store.source_root, p)).casefold()
                     for p in worker.get("write_paths", []) + worker.get("outputs", [])}
            if occupied & paths:
                fail("WRITE_SCOPE_CONFLICT", "Parallel workers must use disjoint paths; integrate as a dependent task")
            occupied.update(paths)
        if workers:
            writes = self.path_keys(p for w in workers for p in w.get("write_paths", []))
            outputs = self.path_keys(p for w in workers for p in w.get("outputs", []))
            if writes != self.path_keys(d.get("write_paths", d.get("outputs", []))) or outputs != self.path_keys(d.get("outputs", [])):
                fail("WORKER_SCOPE_GAP", "Assignments must cover exactly the task write paths and outputs")
        if kind == "milestone" and (workers or d.get("outputs") or d.get("write_paths") or d.get("required_runs")):
            fail("MILESTONE_NOT_EXECUTABLE", "Milestones describe future scope; put writes and checks in executable children")
        priority = d.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool):
            fail("INVALID_PRIORITY", "Priority is an integer; larger values run first")
        if previous and routed(previous) and previous.get("work_type") != kind and not d.get("routing_reason_blob"):
            fail("ROUTING_REASON_REQUIRED", "A route change needs its decision and reason")
        criteria = d.get("criteria", {})
        if not isinstance(criteria, dict) or any(not isinstance(k, str) or not isinstance(v, str) or not v.strip() for k, v in criteria.items()):
            fail("INVALID_CRITERIA", "Criteria map stable ids to agreed descriptions")
        return dict(work_type=kind, workflow_policy=policy, parent=d.get("parent"),
                    owner=d.get("owner", "pm"), criteria=criteria,
                    workers=workers, prerequisites=d.get("prerequisites", []),
                    decision_dependencies=d.get("decision_dependencies", []),
                    specialist_review=bool(d.get("specialist_review", False)),
                    routing_reason_blob=self.blob(d["routing_reason_blob"]) if d.get("routing_reason_blob") else None)

    def decision_basis(self, task):
        records = []
        for did in task.get("decision_dependencies", []):
            decision = self.optional("decision", did)
            if not decision or not decision.get("current"):
                fail("NEEDS_DECISION", "PM must record the required design decision", decision=did)
            self.grant(decision["grant"], decision["domain"], task["mission"], decision["effects"])
            records.append(decision)
        return records

    def environment_basis(self, task):
        from .paths import resolve_ref, contained
        files = []
        prerequisites = list(task.get("prerequisites", []))
        constructed_paths = self.path_keys(task["write_paths"] + task["outputs"])
        known_paths = self.path_keys(p["path"] for p in prerequisites if isinstance(p, dict) and p.get("path"))
        for req, _ in self.contract(task)["verification"]:
            for ref in req["inputs"]:
                key = path_key(self.store.source_root, ref)
                if key not in constructed_paths and key not in known_paths:
                    prerequisites.append({"path": ref})
                    known_paths.add(key)
        for item in prerequisites:
            if not isinstance(item, dict) or not item.get("path"):
                fail("INVALID_PREREQUISITE", "Prerequisites need an explicit input path")
            ref = item["path"]
            if path_key(self.store.source_root, ref) in constructed_paths:
                fail("INVALID_PREREQUISITE", "Expected construction outputs are not prerequisite inputs", path=ref)
            path = resolve_ref(self.store.source_root, ref)
            if any(contained(path, p) for p in (self.store.path, self.store.source_root / ".claude", self.store.source_root / ".git")):
                fail("PRIVATE_INPUT_FORBIDDEN", "Prerequisite reads private runtime state")
            actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() and not path.is_symlink() else None
            if actual is None:
                fail("PREREQUISITE_MISSING", "Required input does not exist", path=ref)
            if item.get("sha256") and item["sha256"] != actual:
                fail("STALE_PREREQUISITE", "Required interface or input version changed", path=ref)
            files.append([ref, actual])
        profiles = []
        for _, profile in self.contract(task)["verification"]:
            from pathlib import Path
            executable = Path(profile["canonical"]["executor_argv"][0] if profile.get("canonical") else profile["executable"])
            if not executable.is_file():
                fail("PREREQUISITE_MISSING", "Registered interpreter is unavailable")
            import json
            modules = []
            if profile.get("canonical"):
                from .canonical import executable_manifest
                canonical = profile["canonical"]
                actual = executable_manifest(canonical["executor_argv"], [f["path"] for f in canonical["executor_files"]], self.store.source_root)
                if actual != canonical["executor_files"]:
                    fail("STALE_PREREQUISITE", "Pinned canonical executor bytes changed")
                profiles.append([profile, actual])
                continue
            preflight = json.loads(self.store.blobs.get(profile["preflight_blob"]))
            for name, module in preflight.get("modules", {}).items():
                if module.get("origin") and module.get("sha256"):
                    origin = Path(module["origin"])
                    if not origin.is_file():
                        fail("PREREQUISITE_MISSING", "A registered library is unavailable", module=name)
                    modules.append([name, hashlib.sha256(origin.read_bytes()).hexdigest()])
            profiles.append([profile, hashlib.sha256(executable.read_bytes()).hexdigest(), modules])
        return {"files": files, "environments": profiles}

    def receipt_basis(self, receipt, environment=True):
        if not receipt["current"]:
            fail("SUPERSEDED_RECEIPT", "Use the current issued receipt")
        task = self.admission(receipt["admission"])
        disposition = self.optional("task_disposition", task["id"])
        if disposition and disposition["contract_digest"] == digest(self.contract(task)):
            fail("TASK_DISPOSED", "Deferred or cancelled work cannot be dispatched or satisfy a dependency")
        if receipt["contract_digest"] != digest(self.contract(task)):
            fail("SUPERSEDED_RECEIPT", "Material contract change requires a new receipt")
        basis = {"contract": receipt["contract_digest"], "authority": self.receipt_authority(task),
                 "dependencies": self.dependency_digest(task), "decisions": self.decision_basis(task),
                 "fence": self.task_fence(task)}
        if environment:
            basis["environment"] = self.environment_basis(task)
        return basis

    def do_secretary_delegate(self, d):
        self.only("pm")
        decision = self.get("decision", d["decision"])
        if decision["mission"] != d["mission"] or not decision["current"]:
            fail("STALE_DELEGATION", "Delegation needs a current PM decision")
        self.grant(decision["grant"], decision["domain"], d["mission"], decision["effects"])
        operations = d.get("operations", [])
        if not operations or not set(operations).issubset({"issue", "dispatch", "refresh", "repair", "schedule", "escalate"}):
            fail("INVALID_DELEGATION", "Declare only operational Secretary permissions")
        tasks = d.get("tasks", [])
        if not tasks or any(self.get("task", tid)["mission"] != d["mission"] for tid in tasks):
            fail("INVALID_DELEGATION", "Delegation needs explicit same-mission task scope")
        cap = d.get("max_actions", 100)
        if not isinstance(cap, int) or isinstance(cap, bool) or cap < 1:
            fail("INVALID_DELEGATION", "Delegation needs a finite positive action budget")
        priority_range = d.get("priority_range")
        if priority_range is not None and (not isinstance(priority_range, list) or len(priority_range) != 2 or
                any(not isinstance(v, int) or isinstance(v, bool) for v in priority_range) or priority_range[0] > priority_range[1]):
            fail("INVALID_DELEGATION", "Priority delegation is an inclusive integer range")
        expires = d.get("expires")
        import math
        if expires is not None and (not isinstance(expires, (int, float)) or isinstance(expires, bool) or not math.isfinite(expires)):
            fail("INVALID_DELEGATION", "Expiry must be a finite Unix timestamp")
        delegation = self.create("delegation", dict(mission=d["mission"], decision=decision["id"],
            decision_digest=digest(decision), operations=operations, tasks=tasks, max_actions=cap,
            expires=d.get("expires"), priority_range=priority_range, authority_digest=self.delegation_authority(d["mission"], decision),
            source_blob=self.blob(d["source_blob"])), d.get("id"))
        return {"delegation": delegation}

    def secretary(self, d, operation, task):
        self.only("secretary")
        delegation = self.get("delegation", d["delegation"])
        decision = self.get("decision", delegation["decision"])
        if delegation["mission"] != task["mission"] or task["id"] not in delegation["tasks"] or operation not in delegation["operations"]:
            fail("DELEGATION_SCOPE", "Secretary operation is outside its recorded delegation")
        if not decision["current"] or digest(decision) != delegation["decision_digest"] or delegation["authority_digest"] != self.delegation_authority(task["mission"], decision) or (delegation.get("expires") is not None and self.now >= delegation["expires"]):
            fail("STALE_DELEGATION", "Refresh delegation after authority or PM policy changes")
        self.grant(decision["grant"], decision["domain"], task["mission"], decision["effects"])
        self.charge(delegation["id"], "secretary_actions", delegation["max_actions"])
        return delegation

    def do_receipt_issue(self, d):
        task = self.get("task", d["task"])
        self.secretary(d, "issue", task)
        if not routed(task) or task.get("work_type") == "milestone":
            fail("INVALID_ROUTE", "Issue receipts only for routed executable subtasks")
        if not d.get("admission"):
            admission = self.admit_task(dict(task=task["id"], review=d["review"], permit=d.get("permit")))["admission"]
            d = dict(d, admission=admission["id"])
        if self.get("admission", d["admission"])["task"] != task["id"]:
            fail("INVALID_SCOPE", "Receipt admission belongs to another task")
        self.admission(d["admission"])
        for old in self.rows("work_receipt", task=task["id"], current=True):
            old_admission = self.get("admission", old["admission"])
            new_admission = self.get("admission", d["admission"])
            admission_fields = ("target_digest", "authority_digest", "dependency_digest", "fence", "permit", "contract_digest")
            same_admission_basis = all(old_admission.get(k) == new_admission.get(k) for k in admission_fields)
            if old["contract_digest"] == digest(self.contract(task)) and same_admission_basis:
                fail("CURRENT_RECEIPT_EXISTS", "Use the existing receipt for repair; do not reset its lineage")
            self.update("work_receipt", old["id"], current=False)
            for dispatch in self.rows("receipt_dispatch", receipt=old["id"], active=True):
                self.update("receipt_dispatch", dispatch["id"], active=False, superseded=True)
        previous = self.rows("work_receipt", task=task["id"])
        receipt = self.create("work_receipt", dict(mission=task["mission"], task=task["id"],
            admission=d["admission"], contract_digest=digest(self.contract(task)),
            contract=self.contract(task), policy=task["workflow_policy"], lineage=task["lineage"],
            delegation=d["delegation"], current=True, version=len(previous) + 1,
            supersedes=previous[-1]["id"] if previous else None), d.get("id"))
        return {"receipt": self.receipt_summary(receipt)}

    def receipt_summary(self, receipt):
        return {k: receipt[k] for k in ("id", "task", "mission", "admission", "contract_digest", "policy", "lineage", "current", "version", "supersedes")}

    def do_readiness_record(self, d):
        self.only("architect")
        receipt = self.get("work_receipt", d["receipt"])
        if not receipt["current"]:
            fail("SUPERSEDED_RECEIPT", "Inspect the current receipt")
        outcome = d["outcome"]
        if outcome not in ("READY", "BLOCKED", "NEEDS_DECISION", "INPUT_INCOMPLETE"):
            fail("INVALID_VERDICT", "Architect decides prerequisite readiness only")
        if outcome == "READY":
            basis = self.receipt_basis(receipt)
            if d.get("basis") != basis:
                fail("STALE_READINESS_INPUT", "Read the current receipt snapshot before marking readiness")
        else:
            if not d.get("gaps"):
                fail("PREREQUISITE_GAP_REQUIRED", "A blocker must identify the actual missing prerequisite or decision")
            basis = None
        record = self.create("readiness", dict(mission=receipt["mission"], task=receipt["task"],
            receipt=receipt["id"], outcome=outcome, basis=basis, gaps=d.get("gaps", []),
            source_blob=self.blob(d["source_blob"])), d.get("id"))
        return {"readiness": record}

    def ready(self, receipt):
        basis = self.receipt_basis(receipt)
        checks = self.rows("readiness", receipt=receipt["id"])
        if not checks or checks[-1]["outcome"] != "READY":
            fail("READINESS_REQUIRED", "Architect must check this receipt before construction")
        if checks[-1]["basis"] != basis:
            fail("STALE_READINESS", "A relevant prerequisite, environment or authority changed")
        return checks[-1]

    def do_receipt_dispatch(self, d):
        receipt = self.get("work_receipt", d["receipt"])
        task = self.get("task", receipt["task"])
        self.secretary(d, "dispatch", task)
        self.ready(receipt)
        if self.rows("receipt_dispatch", receipt=receipt["id"], active=True):
            fail("ALREADY_DISPATCHED", "Receipt already has an active construction cycle")
        previous = self.rows("receipt_dispatch", receipt=receipt["id"])
        if previous:
            verdict = self.optional("report", previous[-1].get("acceptance"))
            if not verdict or verdict["outcome"] not in ("REPAIR_REQUIRED", "CHANGES_REQUESTED", "CHANGES-REQUESTED") or not self.rows("repair_route", verdict=verdict["id"]):
                fail("REPAIR_ROUTE_REQUIRED", "Secretary must route a concrete in-contract repair before redispatch")
        # Cross-receipt collisions are rejected even if the graph author missed an edge.
        from .paths import resolve_ref
        paths = {str(resolve_ref(self.store.source_root, p)).casefold() for w in task["workers"] for p in w.get("write_paths", []) + w.get("outputs", [])}
        for running in self.rows("receipt_dispatch", active=True):
            other = self.get("task", running["task"])
            other_paths = {str(resolve_ref(self.store.source_root, p)).casefold() for w in other["workers"] for p in w.get("write_paths", []) + w.get("outputs", [])}
            if paths & other_paths:
                fail("WRITE_SCOPE_CONFLICT", "An active receipt owns one of these write paths", task=other["id"])
        maximum = max([r["round"] for r in self.rows("report", kind="development")
                       if self.get("task", r["task"])["lineage"] == task["lineage"]] + [0])
        self.charge(task["lineage"], "receipt_cycles", 3)
        cycle = max(maximum + 1, self.get("budget", task["lineage"] + ":receipt_cycles")["count"])
        if cycle > 3:
            fail("ROUND_CAP", "Replacement and rerouting preserve the three product cycles")
        dispatch = self.create("receipt_dispatch", dict(mission=task["mission"], task=task["id"],
            receipt=receipt["id"], cycle=cycle, active=True, readiness=self.ready(receipt)["id"]), d.get("id"))
        return {"dispatch": dispatch}

    def do_receipt_claim(self, d):
        self.only("constructor")
        receipt = self.get("work_receipt", d["receipt"])
        self.ready(receipt)
        task = self.get("task", receipt["task"])
        worker = next((w for w in task["workers"] if w["id"] == d["worker"]), None)
        if not worker or (worker.get("session") and worker["session"] != self.actor.session):
            fail("WORKER_SCOPE", "Claim only the assigned worker scope")
        dispatches = self.rows("receipt_dispatch", receipt=receipt["id"], active=True)
        if not dispatches:
            fail("DISPATCH_REQUIRED", "Secretary dispatches before a worker claims")
        dispatch = dispatches[-1]
        previous = [c for c in self.rows("worker_claim", dispatch=dispatch["id"], worker=d["worker"]) if c.get("current", True)]
        if previous:
            prior = previous[-1]
            if prior["author"]["session"] != self.actor.session or d.get("revises") != prior["id"] or prior["readiness_basis"] == self.ready(receipt)["basis"] or self.rows("completion", claim=prior["id"]):
                fail("WORKER_ALREADY_CLAIMED", "Worker has already claimed this cycle")
            self.update("worker_claim", prior["id"], current=False)
        claim = self.create("worker_claim", dict(mission=task["mission"], task=task["id"],
            receipt=receipt["id"], dispatch=dispatch["id"], worker=d["worker"], assignment=worker,
            readiness_basis=self.ready(receipt)["basis"], current=True, revises=d.get("revises")), d.get("id"))
        return {"claim": claim}

    def worker_guard(self, task, path=None, requirement=None):
        if not routed(task) or task.get("work_type") == "milestone":
            return
        receipts = self.rows("work_receipt", task=task["id"], current=True)
        if not receipts:
            fail("RECEIPT_REQUIRED", "Routed work requires an issued receipt")
        receipt = receipts[-1]
        self.ready(receipt)
        dispatches = self.rows("receipt_dispatch", receipt=receipt["id"], active=True)
        if not dispatches:
            fail("DISPATCH_REQUIRED", "Construction has no active cycle")
        if self.actor.role in ("stabilizer", "crititor"):
            if path:
                fail("ROLE_FORBIDDEN", "Acceptance seats cannot write the product")
            return
        session = self.actor.session
        if self.actor.role == "controller":
            # The executor records under an internal identity; runner forwards its requester.
            session = self.request.get("data", {}).get("requester_session")
            if self.request.get("data", {}).get("requester_role") in ("crititor", "stabilizer"):
                return
        claims = [c for c in self.rows("worker_claim", dispatch=dispatches[-1]["id"])
                  if c["author"]["session"] == session and c.get("current", True)]
        if not claims:
            fail("WORKER_CLAIM_REQUIRED", "Constructor must claim its assigned receipt scope")
        if any(c["readiness_basis"] != self.ready(receipt)["basis"] for c in claims):
            fail("STALE_WORKER_CLAIM", "A changed inspected prerequisite needs an acknowledged worker claim")
        key = path_key(self.store.source_root, path) if path is not None else None
        if key is not None and not any(key in self.path_keys(c["assignment"].get("write_paths", []) + c["assignment"].get("outputs", [])) for c in claims):
            fail("WORKER_SCOPE", "Write or delivery is outside this Constructor's assignment")
        if requirement:
            if not any(requirement.get("worker") == c["worker"] for c in claims):
                fail("WORKER_SCOPE", "Verification belongs to another Constructor")
            destinations = self.path_keys(o["destination"] for o in requirement.get("outputs", []))
            if destinations and not any(destinations.issubset(self.path_keys(c["assignment"].get("outputs", []))) for c in claims):
                fail("WORKER_SCOPE", "Run outputs cross worker assignments; use a dependent integration task")
        relevant = [c for c in claims if (key is None or key in self.path_keys(c["assignment"].get("write_paths", []) + c["assignment"].get("outputs", [])))
                    and (not requirement or requirement.get("worker") == c["worker"])]
        if (path or requirement) and relevant and all(self.rows("completion", claim=c["id"]) for c in relevant):
            fail("WORKER_ALREADY_COMPLETED", "A finished worker changes delivery only through a routed repair cycle")

    def do_completion_record(self, d):
        self.only("constructor")
        receipt = self.get("work_receipt", d["receipt"])
        task = self.get("task", receipt["task"])
        self.worker_guard(task)
        claim = self.get("worker_claim", d["claim"])
        dispatch = self.get("receipt_dispatch", claim["dispatch"])
        if claim["receipt"] != receipt["id"] or claim["author"]["session"] != self.actor.session or not claim.get("current", True) or not dispatch["active"]:
            fail("WORKER_SCOPE", "Completion must belong to this worker and active cycle")
        if self.rows("completion", claim=claim["id"]):
            fail("COMPLETION_EXISTS", "Completion is immutable; record a repair cycle for changed delivery")
        assigned_runs = [rid for rid in task["required_runs"] if self.get("requirement", rid).get("worker") == claim["worker"]]
        self.required_satisfied(dict(task, required_runs=assigned_runs))
        outputs = self.output_basis(task, claim["assignment"].get("outputs", []))
        completion = self.create("completion", dict(mission=task["mission"], task=task["id"],
            receipt=receipt["id"], dispatch=dispatch["id"], claim=claim["id"], worker=claim["worker"],
            outputs=outputs, changes=[x["id"] for x in self.rows("work_change", task=task["id"])
                                     if x.get("author", {}).get("session") == self.actor.session and x["created"] >= dispatch["created"]],
            runs=[self.latest_attempt(r)["id"] for r in assigned_runs if self.get("requirement", r)["required"]],
            source_blob=self.blob(d["source_blob"]), gaps=d.get("gaps", [])), d.get("id"))
        completed = self.rows("completion", dispatch=dispatch["id"])
        if receipt["policy"] == "fast" and {c["worker"] for c in completed} == {w["id"] for w in task["workers"]}:
            self.required_satisfied(task)
            self.output_basis(task, task["outputs"])
            for prior in self.rows("report", task=task["id"], kind="development", current=True):
                self.update("report", prior["id"], current=False)
            report = self.create("report", dict(mission=task["mission"], task=task["id"], kind="development",
                outcome="COMPLETE", policy="fast", receipt=receipt["id"], dispatch=dispatch["id"],
                target_digest=digest(task), product_digest=self.product_digest(task),
                current=True, round=dispatch["cycle"], completions=[c["id"] for c in completed],
                source_blob=self.store.blobs.put(json_bytes({"completions": [c["id"] for c in completed]}))))
            self.update("receipt_dispatch", dispatch["id"], development=report["id"])
        return {"completion": {"id": completion["id"], "receipt": receipt["id"], "worker": claim["worker"]},
                "constructed": len(completed) == len(task["workers"])}

    def do_completion_annotate(self, d):
        self.only("constructor")
        completion = self.get("completion", d["completion"])
        if completion["author"]["session"] != self.actor.session:
            fail("WORKER_SCOPE", "Only the original worker may annotate its completion")
        annotation = self.create("completion_annotation", dict(mission=completion["mission"], task=completion["task"],
            completion=completion["id"], source_blob=self.blob(d["source_blob"])))
        return {"annotation": annotation, "metadata_only": True}

    def output_basis(self, task, paths):
        from .paths import resolve_ref
        result = []
        for ref in paths:
            key = path_key(self.store.source_root, ref)
            deliveries = [d for d in self.rows("delivery", task=task["id"], current=True)
                          if path_key(self.store.source_root, d["path"]) == key]
            path = resolve_ref(self.store.source_root, ref)
            if not deliveries or not path.is_file() or path.is_symlink():
                fail("INPUT_INCOMPLETE", "Every assigned output needs actual bytes and an immutable snapshot", path=ref)
            if hashlib.sha256(path.read_bytes()).hexdigest() != deliveries[-1]["source_blob"]:
                fail("STALE_DELIVERY", "Actual delivery differs from its recorded bytes", path=ref)
            result.append([ref, deliveries[-1]["source_blob"]])
        return result

    def product_digest(self, task):
        basis = self.calibration_basis(task, reports=False)
        if task.get("workflow_policy") == "fast":
            # Reviewer execution may add newer proof and identical delivery snapshots.
            # Actual product bytes and reviewed definitions determine product identity;
            # the acceptance candidate separately binds the current qualified run ids.
            basis = {key: value for key, value in basis.items() if key not in ("runs", "deliveries")}
        return digest(basis)

    def candidate(self, receipt):
        task = self.get("task", receipt["task"])
        self.ready(receipt)
        dispatches = self.rows("receipt_dispatch", receipt=receipt["id"])
        if not dispatches or not dispatches[-1].get("development"):
            fail("CONSTRUCTION_INCOMPLETE", "All assigned Constructors must finish before acceptance")
        dispatch = dispatches[-1]
        completed = self.rows("completion", dispatch=dispatch["id"])
        if {c["worker"] for c in completed} != {w["id"] for w in task["workers"]}:
            fail("CONSTRUCTION_INCOMPLETE", "A worker's completion is missing")
        self.required_satisfied(task)
        for completion in completed:
            worker = next(w for w in task["workers"] if w["id"] == completion["worker"])
            if completion["outputs"] != self.output_basis(task, worker.get("outputs", [])):
                fail("STALE_DELIVERY", "A completed worker's outputs changed")
            if completion["gaps"]:
                fail("INPUT_INCOMPLETE", "Constructor declared unresolved delivery gaps")
        product = self.product_digest(task)
        development = self.get("report", dispatch["development"])
        if not development["current"] or development["product_digest"] != product:
            fail("STALE_CANDIDATE", "Integrated product changed after completion")
        return {"receipt_basis": self.receipt_basis(receipt), "dispatch": dispatch["id"],
                "development": development["id"], "product_digest": product,
                "completions": [c["id"] for c in completed], "outputs": self.output_basis(task, task["outputs"]),
                "runs": [self.latest_attempt(rid)["id"] for rid in task["required_runs"]
                         if self.get("requirement", rid)["required"]]}

    def do_acceptance_record(self, d):
        self.only("stabilizer")
        receipt = self.get("work_receipt", d["receipt"])
        if receipt["policy"] != "fast":
            fail("EXPLORATION_REVIEW_REQUIRED", "Exploration uses the existing independent report chain")
        task = self.get("task", receipt["task"])
        outcome = d["outcome"]
        if outcome not in ("ACCEPTED", "REPAIR_REQUIRED", "NEEDS_DECISION", "INPUT_INCOMPLETE"):
            fail("INVALID_VERDICT", "Use a receipt acceptance outcome")
        dispatches = self.rows("receipt_dispatch", receipt=receipt["id"])
        if not dispatches or not dispatches[-1].get("development"):
            fail("CONSTRUCTION_INCOMPLETE", "Finish all Constructors before acceptance")
        dispatch = dispatches[-1]
        workers = self.rows("worker_claim", dispatch=dispatch["id"])
        if any(w["author"]["session"] == self.actor.session for w in workers):
            fail("INDEPENDENCE_REQUIRED", "Acceptance must come from a different actor instance")
        source = self.blob(d["source_blob"])
        if outcome == "ACCEPTED":
            basis = self.candidate(receipt)
            if d.get("basis") != basis:
                fail("STALE_ACCEPTANCE_INPUT", "Acceptance must bind the actual current integrated candidate")
            criteria = d.get("criteria", {})
            if set(criteria) != set(task["criteria"]) or any(not isinstance(v, dict) or v.get("status") != "met" or not v.get("evidence") for v in criteria.values()):
                fail("UNMET_CRITERION", "Every criterion needs an independent met verdict and actual evidence")
            evidence = {sha for _, sha in basis["outputs"]}
            evidence.update(self.get("completion", cid)["source_blob"] for cid in basis["completions"])
            for rid in task["required_runs"]:
                run = self.latest_attempt(rid)
                if run:
                    evidence.update([run["id"], run.get("stdout_blob"), run.get("stderr_blob")])
            for criterion in criteria.values():
                if not isinstance(criterion["evidence"], list) or not set(criterion["evidence"]).issubset(evidence):
                    fail("INVALID_CRITERION_EVIDENCE", "Criterion evidence must name this candidate's outputs, completions or runs")
            if task.get("specialist_review"):
                review = self.optional("report", d.get("critique"))
                if not review or review["kind"] != "critique" or review["outcome"] != "PASS" or not review["current"] or review["task"] != task["id"] or review.get("development") != dispatch["development"] or review.get("product_digest") != basis["product_digest"] or review["author"]["session"] == self.actor.session:
                    fail("CURRENT_INDEPENDENT_PASS_REQUIRED", "Declared specialist review must pass on this candidate")
        else:
            if not d.get("findings"):
                fail("FINDING_REQUIRED", "A nonacceptance identifies concrete defects or missing decisions")
            basis, criteria = None, d.get("criteria", {})
        old = self.rows("report", task=task["id"], kind="acceptance", current=True)
        if old and old[-1].get("dispatch") == dispatch["id"]:
            if old[-1]["outcome"] != "INPUT_INCOMPLETE" or d.get("revises") != old[-1]["id"]:
                fail("ACCEPTANCE_EXISTS", "A judged candidate needs an authorised repair before a new verdict")
        for prior in old:
            self.update("report", prior["id"], current=False)
        report = self.create("report", dict(mission=task["mission"], task=task["id"], kind="acceptance",
            outcome=outcome, policy="fast", receipt=receipt["id"], dispatch=dispatch["id"],
            basis=basis, criteria=criteria, findings=d.get("findings", []), source_blob=source,
            target_digest=digest(task), product_digest=(basis or {}).get("product_digest"),
            development=dispatch["development"], critique=d.get("critique"), current=True,
            round=dispatch["cycle"], admission=receipt["admission"]), d.get("id"))
        self.update("receipt_dispatch", dispatch["id"], active=False, acceptance=report["id"])
        if outcome == "ACCEPTED":
            for oid in task["obligations"]:
                self.update("obligation", oid, status="MET", evidence=report["id"])
        return {"acceptance": {"id": report["id"], "receipt": receipt["id"], "outcome": outcome}}

    def fast_acceptance(self, task):
        reports = self.rows("report", task=task["id"], kind="acceptance", current=True)
        if not reports or reports[-1]["outcome"] != "ACCEPTED" or reports[-1].get("policy") != "fast":
            fail("CURRENT_ACCEPTANCE_REQUIRED", "Receipt has no current independent acceptance")
        report = reports[-1]
        receipt = self.get("work_receipt", report["receipt"])
        if not receipt["current"] or report["target_digest"] != digest(task) or report["basis"] != self.candidate(receipt):
            fail("STALE_ACCEPTANCE", "Accepted delivery or its relevant basis changed")
        return report

    def do_secretary_coordinate(self, d):
        task = self.get("task", d["task"])
        operation = d["operation"]
        delegation = self.secretary(d, operation, task)
        if operation not in ("refresh", "repair", "schedule", "escalate"):
            fail("INVALID_COORDINATION", "Issue and dispatch use their dedicated receipt actions")
        if operation == "repair":
            verdicts = self.rows("report", task=task["id"], kind="acceptance", current=True)
            if not verdicts or verdicts[-1]["outcome"] not in ("REPAIR_REQUIRED", "CHANGES_REQUESTED", "CHANGES-REQUESTED"):
                fail("REPAIR_FINDING_REQUIRED", "Routine repair needs a concrete independent finding")
            count = (self.optional("budget", task["lineage"] + ":receipt_cycles") or {}).get("count", 0)
            if count >= 3:
                fail("BUDGET_EXHAUSTED", "Escalate exhausted repair budgets to PM")
            self.qualify(task["mission"], [task["id"]], task["obligations"])
            self.create("repair_route", dict(mission=task["mission"], task=task["id"], verdict=verdicts[-1]["id"],
                                             source_blob=self.blob(d["source_blob"])))
        if operation == "schedule":
            # Only activate an already reviewed producer. A new interface or graph edge is PM work.
            admissions = self.rows("admission", task=task["id"])
            if not admissions:
                fail("PM_PLAN_REQUIRED", "New prerequisite definitions and dependencies require PM and plan review")
            self.admission(admissions[-1]["id"])
            if "priority" in d:
                priority_range = delegation.get("priority_range")
                priority = d["priority"]
                if not priority_range or not isinstance(priority, int) or isinstance(priority, bool) or not priority_range[0] <= priority <= priority_range[1]:
                    fail("DELEGATION_SCOPE", "Changing a priority commitment needs PM or an explicit scheduling range")
                self.schedule(task, priority, d["source_blob"])
        view = self.task_view(task)
        event = self.create("coordination", dict(mission=task["mission"], task=task["id"],
            operation=operation, delegation=d["delegation"], source_blob=self.blob(d["source_blob"]),
            qualification=view, escalation=(operation == "escalate" or view["state"] == "NEEDS_DECISION")))
        return {"coordination": {"id": event["id"], "task": task["id"], "operation": operation}, "task": view}

    def schedule(self, task, priority, source):
        return self.put("schedule", task["id"], dict(mission=task["mission"], task=task["id"], priority=priority,
                        source_blob=self.blob(source), author=self.actor.record()))

    def do_schedule_record(self, d):
        self.only("pm")
        task = self.get("task", d["task"])
        self.grant(task["grant"], task["domain"], task["mission"])
        if not isinstance(d["priority"], int) or isinstance(d["priority"], bool):
            fail("INVALID_PRIORITY", "Priority is an integer")
        return {"schedule": self.schedule(task, d["priority"], d["source_blob"])}

    def do_task_dispose(self, d):
        self.only("pm", "principal")
        task = self.get("task", d["task"])
        if not routed(task):
            fail("INVALID_ROUTE", "Use obligation dispositions for historical tasks")
        if d["outcome"] not in ("DEFERRED", "CANCELLED") or not d.get("owner"):
            fail("INVALID_DISPOSITION", "Declare DEFERRED or CANCELLED with its responsible owner")
        self.grant(d["grant"], task["domain"], task["mission"], permission="defer")
        disposition = self.put("task_disposition", task["id"], dict(mission=task["mission"], task=task["id"],
            outcome=d["outcome"], owner=d["owner"], grant=d["grant"], domain=task["domain"],
            source_blob=self.blob(d["source_blob"]), contract_digest=digest(self.contract(task)), author=self.actor.record()))
        for dispatch in self.rows("receipt_dispatch", task=task["id"], active=True):
            self.update("receipt_dispatch", dispatch["id"], active=False, disposition=disposition["id"])
        return {"disposition": disposition}

    def disposed(self, task):
        disposition = self.optional("task_disposition", task["id"])
        if not disposition or disposition["contract_digest"] != digest(self.contract(task)):
            return False
        self.grant(disposition["grant"], disposition["domain"], task["mission"], permission="defer")
        return True

    def task_view(self, task):
        view = {"id": task["id"], "parent": task.get("parent"), "work_type": task.get("work_type", "exploration"),
                "policy": task.get("workflow_policy", "v4"), "priority": (self.optional("schedule", task["id"]) or {}).get("priority", 0),
                "dependencies": task.get("dependencies", []), "decisions": task.get("decision_dependencies", []),
                "unlocks": [t["id"] for t in self.rows("task", mission=task["mission"]) if task["id"] in t.get("dependencies", [])],
                "recorded_acceptance": None, "qualified": False, "state": "PLANNED", "reasons": []}
        reports = self.rows("report", task=task["id"], kind="acceptance", outcome="ACCEPTED")
        if reports:
            view["recorded_acceptance"] = reports[-1]["id"]
        if task.get("work_type") == "milestone":
            view["children"] = [t["id"] for t in self.rows("task", mission=task["mission"]) if t.get("parent") == task["id"] and t["status"] != "REPLACED"]
            return view
        receipts = self.rows("work_receipt", task=task["id"], current=True)
        try:
            if self.disposed(task):
                view.update(state=self.get("task_disposition", task["id"])["outcome"])
                return view
            self.qualify(task["mission"], [task["id"]], task["obligations"])
            self.decision_basis(task)
            self.dependency_digest(task)
            current = self.rows("report", task=task["id"], kind="acceptance", current=True)
            active = self.rows("receipt_dispatch", receipt=receipts[-1]["id"], active=True) if receipts else []
            advancing = active and (not current or active[-1].get("acceptance") != current[-1]["id"])
            if current and current[-1]["outcome"] != "ACCEPTED" and not advancing:
                view["state"] = {"CHANGES_REQUESTED": "REPAIR_REQUIRED", "CHANGES-REQUESTED": "REPAIR_REQUIRED"}.get(current[-1]["outcome"], current[-1]["outcome"])
                view["reasons"] = current[-1].get("findings", [])
                return view
            if reports and not advancing:
                self.required_satisfied(task)
                accepted = self.task_acceptance(task)
                view.update(state="ACCEPTED", qualified=True, acceptance=accepted["id"])
                return view
            if not receipts:
                return view
            receipt = receipts[-1]
            view.update(receipt=receipt["id"], state="ISSUED")
            checks = self.rows("readiness", receipt=receipt["id"])
            if checks and checks[-1]["outcome"] != "READY":
                view.update(state=checks[-1]["outcome"], reasons=checks[-1]["gaps"])
                return view
            self.ready(receipt)
            view["state"] = "READY"
            dispatches = self.rows("receipt_dispatch", receipt=receipt["id"])
            if dispatches:
                dispatch = dispatches[-1]
                view["state"] = "CONSTRUCTED" if dispatch.get("development") else "RUNNING"
                if dispatch.get("acceptance"):
                    verdict = self.get("report", dispatch["acceptance"])
                    view["state"] = verdict["outcome"]
        except RuntimeRefusal as exc:
            view["state"] = "NEEDS_DECISION" if exc.code == "NEEDS_DECISION" else ("STALE" if reports else "BLOCKED")
            view["reasons"] = [{"code": exc.code, "detail": str(exc)}]
        return view


def inspect(engine, action, data):
    """Public read operations; deliberately never calls store.transact."""
    from .workflow import Workflow
    workflow = Workflow(engine.store, engine.actor)
    workflow.state = engine.store.read()
    workflow.now = time.time()
    if action == "queue.snapshot":
        workflow.get("root", data["mission"])
        views = [workflow.task_view(t) for t in workflow.rows("task", mission=data["mission"]) if t["status"] != "REPLACED"]
        views.sort(key=lambda v: (-v["priority"], v["id"]))
        return {"ok": True, "tasks": views, "eligible": [v["id"] for v in views if v["state"] == "READY"],
                "escalations": [v["id"] for v in views if v["state"] == "NEEDS_DECISION"]}
    receipt = workflow.get("work_receipt", data["receipt"])
    result = {"ok": True, "receipt": workflow.receipt_summary(receipt), "contract": receipt["contract"]}
    try:
        result["basis"] = workflow.candidate(receipt) if action == "acceptance.snapshot" else workflow.receipt_basis(receipt)
        result["status"] = "CURRENT"
    except RuntimeRefusal as exc:
        result.update(status="INPUT_INCOMPLETE", reasons=[{"code": exc.code, "detail": str(exc)}])
    return result


def packet_tasks(state, mission, selected):
    """Dependency closure for scoped default packets, without judging delivery."""
    tasks, decisions = set(selected), set()
    pending = list(selected)
    while pending:
        tid = pending.pop()
        task = state.get(("task", tid), {}).get("data", {})
        if task.get("mission") != mission:
            fail("CROSS_MISSION_REFERENCE", "Packet task is outside its mission")
        decisions.update(task.get("decision_dependencies", []))
        for dep in task.get("dependencies", []) + ([task["parent"]] if task.get("parent") else []):
            if dep not in tasks:
                tasks.add(dep)
                pending.append(dep)
    return tasks, decisions
