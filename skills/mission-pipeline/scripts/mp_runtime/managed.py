"""Trusted controller and private JSONL role endpoints.

Drivers are trusted model transports. Model output can only invoke this broker's
typed tools; drivers must not expose parallel host shell/filesystem capabilities.
No bearer credential is written to disk or included in a model packet.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import uuid
import queue
import threading
import time
from pathlib import Path

from .engine import Engine
from .process import RuntimeRefusal, read_json_bytes, json_bytes, validate_argv
from .runner import capability_probe
from .storage import digest
from .workflow import Actor
from .review import review_basis, REVIEW_ACTIONS

ROLE_ACTIONS = {
    "pm": {"intake.create", "root.propose", "root.activate", "decision.record", "plan.record", "task.record", "task.admit", "task.dispatch", "requirement.record", "recovery.permit", "case.contest", "obligation.defer", "flag.change", "bundle.record", "mission.close", "consume"},
    "constructor": {"task.claim", "report.record", "delivery.record", "work.write", "issue.report", "run.execute", "case.contest", "consume", "flag.raise"},
    "crititor": {"report.record", "issue.report", "run.execute", "case.contest", "flag.raise"},
    "stabilizer": {"report.record", "issue.report", "case.contest", "contest.decide", "calibration.record", "latch.release", "run.execute"},
    "supervisor": {"root.review", "plan.review", "issue.report", "issue.screen", "case.resolve", "close.review"},
    "auditor": {"audit.record", "audit.agree", "issue.report", "case.contest"},
    "architect": {"issue.report"},
    "calibrator": {"calibration.record", "issue.report"},
    "challenger": {"issue.report"},
    "researcher": {"issue.report"},
}
ROLE_ACTIONS["pm"].update({"legacy.adopt", "task.replace", "wave.open", "wave.integrate", "context.compacted", "job.resume", "case.supplement"})
ROLE_ACTIONS["constructor"].add("case.supplement")
ROLE_ACTIONS["auditor"].add("case.supplement")
ROLE_ACTIONS["challenger"].add("case.supplement")
ROLE_ACTIONS["supervisor"].update({"rule.record", "rule.retire"})
ROLE_ACTIONS["stabilizer"].update({"rule.record", "rule.retire"})
for _review_role in ("supervisor", "stabilizer", "auditor"):
    ROLE_ACTIONS[_review_role].add("review.rebase")
ROLE_ACTIONS["pm"].update({"obligation.cancel", "legacy.accept"})
# Every seat that may report a counterexample may also contest one and raise a flag.
for _reporter in ("constructor", "crititor", "stabilizer", "auditor", "calibrator",
                  "challenger", "architect", "researcher", "supervisor"):
    ROLE_ACTIONS[_reporter].update({"case.contest", "flag.raise"})
ROLE_ACTIONS["pm"].add("flag.raise")


class ManagedBroker:
    def __init__(self, engine):
        self.engine = engine.with_actor(Actor("controller", "trusted-controller", True))
        self.epoch = engine.store.owner()["epoch"]
        self.sessions = {}

    def start(self):
        probe = capability_probe()
        result = self.engine.mutate("project.configure", {"mode": "managed"}, "managed-start-" + str(self.epoch))
        return dict(result, isolation=probe)

    def principal(self, request):
        if request["action"] not in ("authority.record", "authority.amend", "grant.record", "grant.revoke", "contract.retire", "environment.register", "canonical.register", "latch.release", "mission.reopen", "legacy.adopt"):
            raise RuntimeRefusal("PRINCIPAL_INGRESS_ACTION", "This console only records principal authority or registered execution environments")
        return self.engine.with_actor(Actor("principal", "trusted-principal-ingress", True)).handle(request)

    def seat(self, role, mission, tasks=()):
        if role not in ROLE_ACTIONS:
            raise RuntimeRefusal("ROLE_FORBIDDEN", "Cannot create this role endpoint")
        id = uuid.uuid4().hex
        session = {"id": id, "role": role, "mission": mission, "tasks": list(tasks),
                   "epoch": self.epoch, "calls": 0, "blob_allowlist": set(), "read_blobs": set()}
        self.sessions[id] = session
        return session

    def job_seat(self, job, repair=None):
        assignment = self.engine.mutate("job.claim", {"job": job, "repair": repair}, "job-claim-" + uuid.uuid4().hex)
        session = self.seat(assignment["role"], assignment["mission"])
        self.sessions.pop(session["id"])
        session.update(id=assignment["session"], job=job, generation=assignment["job"]["generation"])
        self.sessions[session["id"]] = session
        return session

    def packet(self, session, delivered=True):
        records, blobs = [], set()
        state = self.engine.store.read()
        adopted = state.get(("legacy_scope", session["mission"]), {}).get("data", {}).get("artifacts", [])
        authorities = {row["data"]["authority"] for (kind, _), row in state.items()
                       if kind in ("root", "intake") and (row["data"].get("mission") == session["mission"] or row["data"].get("id") == session["mission"])}
        for (kind, _), row in state.items():
            value = row["data"]
            if kind == "semantic_overlay" and value["artifact"] in adopted:
                records.append({"kind": kind, "object": value})
                if value.get("source_blob"):
                    blobs.add(value["source_blob"])
                continue
            if kind == "authority" and value["id"] not in authorities:
                continue
            if kind == "grant" and value["authority"] not in authorities:
                continue
            if kind == "root" and value["id"] != session["mission"]:
                continue
            if kind == "environment":
                used = {r["data"]["environment"] for (k, _), r in state.items()
                        if k == "requirement" and r["data"].get("mission") == session["mission"]}
                if value["id"] not in used:
                    continue
            if kind in ("job", "contest"):
                related = state.get(("case", value["case"]), {}).get("data", {})
                if related.get("mission") != session["mission"]:
                    continue
            if kind == "ticket":
                related = state.get(("task", value["task"]), {}).get("data", {})
                if related.get("mission") != session["mission"]:
                    continue
            if kind == "review" and not value.get("mission"):
                # Old v4 projections can infer review ownership, never default to global.
                target_kind = {"root": "candidate", "plan": "plan", "close": "bundle"}.get(value.get("kind"))
                related = state.get((target_kind, value.get("target")), {}).get("data", {})
                if related.get("mission") != session["mission"]:
                    continue
            if value.get("mission") not in (None, session["mission"]):
                continue
            if kind in ("authority", "grant", "root", "candidate", "task", "obligation", "decision", "plan", "case", "barrier", "bundle", "report", "requirement", "run", "audit", "review", "contest", "job", "permit", "admission", "ticket", "environment", "rule", "wave", "work_change", "delivery"):
                # Calibrator receives delivery facts and authority, not PM's narrative defense.
                if session["role"] == "calibrator" and kind in ("case", "plan", "review", "contest"):
                    continue
                records.append({"kind": kind, "object": value})
                for key, ref in value.items():
                    if key.endswith("_blob") and isinstance(ref, str):
                        blobs.add(ref)
                if kind == "bundle":
                    blobs.update(item["blob"] for item in value["items"])
                if kind == "task":
                    blobs.update(value.get("inputs", []))
                if kind == "run":
                    for item in read_json_bytes(self.engine.store.blobs.get(value["input_blob"])):
                        blobs.add(item["blob"])
        from .contracts import required_records
        for kind, value in required_records(state, session["mission"]):
            if not any(r["kind"] == kind and r["object"]["id"] == value["id"] for r in records):
                records.append({"kind": kind, "object": value})
            if value.get("source_blob"):
                blobs.add(value["source_blob"])
        bases = {}
        for (kind, ident), row in state.items():
            if kind in ("case", "latch") and row["data"].get("mission") == session["mission"]:
                basis = review_basis(state, {kind: ident})
                bases[kind + ":" + ident] = basis
                blobs.update(basis["blobs"])
        if delivered:
            session["review_bases"] = bases
            from .contracts import contract_digest
            session["contract_scope_digest"] = contract_digest(state, session["mission"])
        session["blob_allowlist"].update(blobs)
        role_path = Path(__file__).resolve().parents[2] / "roles" / (session["role"] + ".md")
        instructions = role_path.read_text(encoding="utf-8") if role_path.exists() else "Use only this role's typed tools and actual source evidence."
        from .paths import root_identity
        return {"protocol": 1, "session_public_id": session["id"], "role": session["role"],
                "root_id": root_identity(self.engine.root)["root_id"],
                "mission": session["mission"], "instructions": instructions,
                "records": records, "input_manifest": sorted(blobs), "review_bases": bases,
                "allowed_tools": ["read_blob", "read_blobs", "submit_blob", "submit", "refresh_packet"],
                "allowed_actions": sorted(ROLE_ACTIONS[session["role"]]), "tool_budget": 128}

    def tool(self, session, call):
        if self.sessions.get(session["id"]) is not session or session["epoch"] != self.engine.store.owner()["epoch"]:
            raise RuntimeRefusal("STALE_SESSION", "Role endpoint is no longer valid")
        if session.get("job"):
            job = self.engine.object("job", session["job"])
            if job.get("instance") != session["id"] or job["generation"] != session["generation"] or not job.get("occupied"):
                raise RuntimeRefusal("STALE_SESSION", "Durable job generation no longer owns this endpoint")
        session["calls"] += 1
        if session["calls"] > 128:
            raise RuntimeRefusal("BUDGET_EXHAUSTED", "Role tool budget exhausted")
        tool = call.get("tool")
        if tool == "read_blobs":
            refs = call.get("blobs", [])
            if not isinstance(refs, list) or not refs or len(refs) > 64:
                raise RuntimeRefusal("INVALID_INPUT", "A batch must contain between one and 64 blob references")
            if any(ref not in session["blob_allowlist"] for ref in refs):
                raise RuntimeRefusal("INPUT_OUTSIDE_PACKET", "Role cannot read a blob outside its packet")
            items = [{"blob": ref, "base64": base64.b64encode(self.engine.store.blobs.get(ref)).decode("ascii")} for ref in refs]
            if len(json_bytes(items)) > 8 * 1024 * 1024:
                raise RuntimeRefusal("INVALID_INPUT", "Read batch exceeds framing size; request smaller batches")
            session["read_blobs"].update(refs)
            return {"blobs": items}
        if tool == "read_blob":
            sha = call.get("blob")
            if sha not in session["blob_allowlist"]:
                raise RuntimeRefusal("INPUT_OUTSIDE_PACKET", "Role cannot read a blob outside its packet")
            raw = self.engine.store.blobs.get(sha)
            session["read_blobs"].add(sha)
            return {"blob": sha, "base64": base64.b64encode(raw).decode("ascii")}
        if tool == "submit_blob":
            raw = base64.b64decode(call["base64"], validate=True)
            if len(raw) > 8 * 1024 * 1024:
                raise RuntimeRefusal("INVALID_INPUT", "Role submission exceeds size limit")
            sha = self.engine.store.blobs.put(raw)
            session["blob_allowlist"].add(sha)
            return {"blob": sha}
        if tool == "refresh_packet":
            return self.packet(session)
        if tool != "submit":
            raise RuntimeRefusal("TOOL_FORBIDDEN", "Unknown tools never fall back to a host shell")
        request = call["request"]
        if request.get("action") not in ROLE_ACTIONS[session["role"]]:
            raise RuntimeRefusal("ROLE_FORBIDDEN", "This endpoint cannot submit the requested action")
        data = request.get("data", {})
        def check_blobs(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.endswith("_blob") and child and child not in session["blob_allowlist"]:
                        raise RuntimeRefusal("INPUT_OUTSIDE_PACKET", "Submission refers to input outside its scoped packet")
                    check_blobs(child)
            elif isinstance(value, list):
                for child in value:
                    check_blobs(child)
        check_blobs(data)
        if "actor" in request or "session" in request or "authenticated" in request:
            raise RuntimeRefusal("IDENTITY_FORGERY", "Role identity comes from the private endpoint, not message fields")
        if data.get("mission", session["mission"]) != session["mission"]:
            raise RuntimeRefusal("CROSS_MISSION_REFERENCE", "Endpoint is scoped to another mission")
        reference_kinds = {"task": "task", "case": "case", "bundle": "bundle", "candidate": "candidate",
                           "admission": "admission", "requirement": "requirement", "run": "run", "plan": "plan"}
        for field, kind in reference_kinds.items():
            if field in data:
                value = self.engine.object(kind, data[field])
                if value.get("mission", session["mission"]) != session["mission"]:
                    raise RuntimeRefusal("CROSS_MISSION_REFERENCE", "Referenced object is outside endpoint scope")
                if field == "task" and session["tasks"] and data[field] not in session["tasks"]:
                    raise RuntimeRefusal("TASK_OUTSIDE_ENDPOINT", "Endpoint does not own this task")
        actor = Actor(session["role"], session["id"], True)
        client_hash = digest(request)
        receipt = self.engine.store.receipt(request["request_id"])
        if receipt:
            prior = receipt.get("request", {}).get("data", {}).get("input_receipt", {})
            if receipt["actor"] != actor.record() or prior.get("client_payload_hash") != client_hash:
                raise RuntimeRefusal("REQUEST_CONFLICT", "Request id already belongs to different content or endpoint")
            return dict(receipt["result"], committed=True, reused=True, request_id=request["request_id"], seq=receipt["seq"])
        required_reads = set()
        basis = None
        if request["action"] in REVIEW_ACTIONS:
            subject_kind = "latch" if request["action"] == "latch.release" else "case"
            basis = session.get("review_bases", {}).get(subject_kind + ":" + str(data.get(subject_kind)))
            if basis is None:
                raise RuntimeRefusal("INPUT_NOT_READ", "Explicitly request the review packet first")
            if data.get("review_basis", basis) != basis:
                raise RuntimeRefusal("STALE_REVIEW_INPUT", "Submission does not match its delivered packet")
            required_reads.update(basis["blobs"])
        if request["action"] in {"root.review", "plan.review", "report.record", "calibration.record", "audit.record", "close.review", "work.write"}:
            packet = self.packet(session, delivered=False)
            for record in packet["records"]:
                kind, value = record["kind"], record["object"]
                if kind in ("authority", "grant"):
                    required_reads.add(value["source_blob"])
                if kind == "candidate" and value["id"] == data.get("candidate"):
                    required_reads.add(value["source_blob"])
                if kind == "task" and value["id"] == data.get("task"):
                    required_reads.add(value["source_blob"])
                    required_reads.update(value["inputs"])
                if kind == "case" and value["id"] == data.get("case"):
                    required_reads.update([value["source_blob"], value["counterexample_blob"]])
                if kind == "bundle" and value["id"] == data.get("bundle"):
                    required_reads.update(item["blob"] for item in value["items"])
                if kind in ("report", "delivery") and value.get("current") and value.get("task") == data.get("task"):
                    required_reads.add(value["source_blob"])
        if not required_reads.issubset(session["read_blobs"]):
            raise RuntimeRefusal("INPUT_NOT_READ", "This judgment or write requires reading its actual authority and target inputs", missing=sorted(required_reads - session["read_blobs"]))
        if basis is not None:
            data = dict(data, review_basis=basis)
        request = dict(request, data=dict(data, input_receipt={"read_blobs": sorted(required_reads), "endpoint": session["id"],
                       "contract_scope_digest": session.get("contract_scope_digest"), "client_payload_hash": client_hash}))
        result = self.engine.with_actor(actor).handle(request)
        self.packet(session, delivered=False)  # Never turns an unseen new basis into a delivered reading.
        return result

    def run_driver(self, session, argv, max_steps=32, timeout=300):
        try:
            validate_argv(argv)
            # Private anonymous pipes; no role credential files or shell=True.
            child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, shell=False, close_fds=True)
        except Exception as exc:
            if session.get("job"):
                self.engine.mutate("job.unavailable", {"job": session["job"], "instance": session["id"],
                    "generation": session["generation"], "reason": getattr(exc, "code", "DRIVER_START_ERROR")}, "job-failed-" + uuid.uuid4().hex)
            self.sessions.pop(session["id"], None)
            raise
        lines = queue.Queue(maxsize=2)
        deadline = time.monotonic() + min(timeout, 300)
        def read_lines():
            while True:
                line = child.stdout.readline(8 * 1024 * 1024 + 1)
                try:
                    lines.put(line, timeout=max(0.01, deadline - time.monotonic()))
                except queue.Full:
                    return
                if not line:
                    return
        reader = threading.Thread(target=read_lines, daemon=True)
        reader.start()
        def send(message):
            raw = json_bytes(message)
            if len(raw) > 8 * 1024 * 1024:
                raise RuntimeRefusal("INVALID_INPUT", "Driver frame exceeds eight MiB")
            result = queue.Queue(maxsize=1)
            def write():
                try:
                    child.stdin.write(raw)
                    child.stdin.flush()
                    result.put(None)
                except (OSError, ValueError) as exc:
                    result.put(exc)
            threading.Thread(target=write, daemon=True).start()
            try:
                error = result.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty as exc:
                raise RuntimeRefusal("DRIVER_DEADLINE", "Driver did not consume its input before deadline") from exc
            if error:
                raise RuntimeRefusal("DRIVER_PROTOCOL_ERROR", "Driver closed its input pipe") from error
        try:
            send({"packet": self.packet(session)})
            for _ in range(min(max_steps, 64)):
                try:
                    line = lines.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty as exc:
                    raise RuntimeRefusal("DRIVER_DEADLINE", "Independent role deadline elapsed") from exc
                if not line:
                    raise RuntimeRefusal("DRIVER_PROTOCOL_ERROR", "Driver ended without a final response")
                message = read_json_bytes(line)
                if "final_document" in message:
                    if session.get("job"):
                        self.engine.mutate("job.transport_finished", {"job": session["job"], "instance": session["id"], "generation": session["generation"]}, "job-finished-" + uuid.uuid4().hex)
                    return {"ok": True, "session": session["id"], "final_document": message["final_document"]}
                results = []
                for call in message.get("tool_calls", []):
                    try:
                        results.append({"ok": True, "result": self.tool(session, call)})
                    except RuntimeRefusal as exc:
                        results.append(exc.body())
                send({"tool_results": results})
            raise RuntimeRefusal("BUDGET_EXHAUSTED", "Driver step budget exhausted")
        except Exception as exc:
            if session.get("job"):
                self.engine.mutate("job.unavailable", {"job": session["job"], "instance": session["id"], "generation": session["generation"], "reason": getattr(exc, "code", "DRIVER_ERROR")}, "job-failed-" + uuid.uuid4().hex)
            raise
        finally:
            child.kill() if child.poll() is None else None
            child.wait(timeout=5)
            child.stdin.close()
            child.stdout.close()
            reader.join(timeout=1)
            self.sessions.pop(session["id"], None)


def main(engine, argv):
    p = argparse.ArgumentParser(prog="mp managed")
    p.add_argument("command", choices=["probe", "start", "principal", "run"])
    p.add_argument("--request-file")
    p.add_argument("--driver-config")
    p.add_argument("--role", choices=sorted(ROLE_ACTIONS))
    p.add_argument("--mission")
    p.add_argument("--job")
    p.add_argument("--repair-file", help="JSON repair_tasks/candidate already independently accepted; resumes the same contest lineage")
    args = p.parse_args(argv)
    broker = ManagedBroker(engine)
    if args.command == "probe":
        result = capability_probe()
    elif args.command == "start":
        result = broker.start()
    elif args.command == "principal":
        result = broker.principal(read_json_bytes(Path(args.request_file).read_bytes()))
    else:
        config = read_json_bytes(Path(args.driver_config).read_bytes())
        if config.get("parallel_host_tools", True):
            raise RuntimeRefusal("UNSUPPORTED_HOST_TOOL_ACCESS", "Managed drivers must expose only broker tools")
        if not args.job and (not args.role or not args.mission):
            raise RuntimeRefusal("ROLE_SCOPE_REQUIRED", "A role and mission are required")
        if args.repair_file and not args.job:
            raise RuntimeRefusal("ROLE_SCOPE_REQUIRED", "Repair compliance requires the original job id")
        repair = read_json_bytes(Path(args.repair_file).read_bytes()) if args.repair_file else None
        seat = broker.job_seat(args.job, repair) if args.job else broker.seat(args.role, args.mission)
        result = broker.run_driver(seat, config["argv"])
    sys.stdout.buffer.write(json_bytes(result))
    return 0
