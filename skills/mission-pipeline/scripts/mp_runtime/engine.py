"""Shared entry point for native CLI, adapter and authenticated managed broker."""
import json
from pathlib import Path

from .process import RuntimeRefusal, json_bytes
from .storage import RuntimeStore
from .workflow import Actor, Workflow


class Engine:
    def __init__(self, root, actor=None, ledger=None):
        from .paths import io_path
        self.root = io_path(Path(root).resolve(), force=True)
        if ledger is None:
            from .process import read_json_bytes
            config_path = self.root / ".claude" / "mission-pipeline" / "mp.json"
            if config_path.exists():
                config = read_json_bytes(config_path.read_bytes())
                if not isinstance(config, dict):
                    raise RuntimeRefusal("INVALID_CONFIG", "Project configuration must be an object; no fallback ledger was opened")
                if "ledger" in config:
                    import os
                    from pathlib import PureWindowsPath
                    value = config["ledger"]
                    if not isinstance(value, str) or "\0" in value:
                        raise RuntimeRefusal("INVALID_CONFIG", "Configured ledger must be an explicit path")
                    if os.name != "nt" and PureWindowsPath(value).drive:
                        raise RuntimeRefusal("PATH_MAPPING_REQUIRED", "Use a root-relative ledger configuration for a shared Windows/WSL project")
                    ledger = Path(value)
                    if not ledger.is_absolute():
                        ledger = config_path.parent / ledger
        self.actor = actor or Actor("pm", "local:pm")
        self.store = RuntimeStore(ledger or self.root / ".claude" / "mission-pipeline" / "ledger")
        self.store.source_root = self.root

    def with_actor(self, actor):
        return Engine(self.root, actor, self.store.path)

    def object(self, kind, id):
        row = self.store.read().get((kind, str(id)))
        if not row:
            raise RuntimeRefusal("MISSING_REFERENCE", "No such runtime object", kind=kind, id=id)
        return row["data"]

    def mutate(self, action, data, request_id):
        request = {"action": action, "data": data, "request_id": request_id}
        workflow = Workflow(self.store, self.actor)
        return self.store.transact(request, self.actor.record(), lambda state: workflow.apply(state, request))

    def handle(self, request):
        if not isinstance(request, dict) or not isinstance(request.get("action"), str) or not isinstance(request.get("data", {}), dict):
            raise RuntimeRefusal("INVALID_INPUT", "A request needs a string action and object data")
        action, data = request.get("action"), request.get("data", {})
        if action in ("queue.snapshot", "receipt.snapshot", "acceptance.snapshot"):
            from .fast import inspect
            return inspect(self, action, data)
        if action == "contracts.snapshot":
            from .contracts import contract_digest, required_records
            state = self.store.read()
            return {"contract_scope_digest": contract_digest(state, data["mission"]),
                    "records": [{"kind": k, "object": v} for k, v in required_records(state, data["mission"])]}
        if action == "review.snapshot":
            from .review import review_basis
            return {"review_basis": review_basis(self.store.read(), data)}
        if action == "delivery.record":
            from .paths import resolve_ref, contained
            task = self.object("task", data["task"])
            if self.actor.role != "constructor" or data["path"] not in task.get("outputs", []):
                raise RuntimeRefusal("UNDECLARED_DELIVERY", "Only a constructor's declared output can be read for delivery")
            path = resolve_ref(self.root, data["path"], must_exist=True)
            if contained(path, self.store.path) or contained(path, self.root / ".claude") or contained(path, self.root / ".git"):
                raise RuntimeRefusal("PRIVATE_INPUT_FORBIDDEN", "Pipeline private state cannot be read as delivery")
            data = dict(data, source_blob=self.store.blobs.put(path.read_bytes()))
            return self.mutate(action, data, request["request_id"])
        if action == "query":
            state = self.store.read()
            if data.get("id"):
                row = state.get((data["kind"], str(data["id"])))
                if not row:
                    raise RuntimeRefusal("MISSING_REFERENCE", "No such runtime object", kind=data["kind"], id=data["id"])
                result = {"ok": True, "object": row["data"]}
            else:
                result = {"ok": True, "objects": [v["data"] for (kind, _), v in state.items()
                                                  if not data.get("kind") or kind == data["kind"]]}
            if data.get("kind") == "task":
                # Stored rows are returned unchanged, so their digests still serve `revises`.
                tasks = [result["object"]] if data.get("id") else result["objects"]
                result["derived"] = Workflow.reader(self.store, state).task_states(tasks)
                result["note"] = ("A task's stored status is its record status (NOT_ADMITTED until task.replace "
                                  "sets REPLACED), not its admission; derived gives admission and acceptance")
            if data.get("kind") == "report" and not data.get("full", False):
                def compact(value):
                    return {k: v for k, v in value.items() if k != "source_fields"}
                if data.get("id"):
                    result["object"] = compact(result["object"])
                else:
                    result["objects"] = [compact(value) for value in result["objects"]]
                result["note"] = "Original source is in source_blob; full:true includes parsed source fields"
            return result
        if action == "receipt":
            return {"ok": True, "receipt": self.store.receipt(data["request_id"])}
        if action == "run.execute":
            from .runner import execute
            return execute(self, dict(data, request_id=request["request_id"]))
        return self.mutate(action, data, request["request_id"])
