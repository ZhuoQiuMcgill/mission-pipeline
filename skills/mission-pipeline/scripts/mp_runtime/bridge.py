"""Windows -> WSL bridge: user content only crosses stdin JSON."""
import argparse
import json
import os
import sys
from pathlib import Path

from .process import RuntimeRefusal, read_json_bytes, json_bytes, run_bytes


def call_wsl(request, distribution="Ubuntu", executable="/usr/bin/python3", entry=None, mapping_file=None):
    if not isinstance(request, dict):
        raise RuntimeRefusal("INVALID_INPUT", "Bridge request must be an object")
    if request.get("role") == "controller":
        raise RuntimeRefusal("ROLE_FORBIDDEN", "controller is the executor's internal identity")
    if os.name != "nt":
        raise RuntimeRefusal("WINDOWS_BRIDGE_REQUIRED", "This client entry is the native Windows to WSL bridge")
    if not entry or not entry.startswith("/") or any("\0" in x for x in (entry, executable, distribution)):
        raise RuntimeRefusal("INVALID_BRIDGE_CONFIG", "Register an absolute Linux entry and interpreter")
    argv = ["wsl.exe", "--distribution", distribution, "--exec", executable, entry, "--bridge-stdio"]
    def transport(value):
        result = run_bytes(argv, input_bytes=json_bytes(value), timeout=value.get("transport_timeout", 120))
        try:
            return read_json_bytes(result.stdout)
        except RuntimeRefusal as exc:
            raise RuntimeRefusal("BRIDGE_PROTOCOL_ERROR", "WSL did not return one JSON response") from exc
    if request.get("root"):
        from .paths import root_identity, io_path
        from .storage import atomic_bytes, digest
        root = request["root"]
        if not isinstance(root, str) or not root.startswith("/") or "\0" in root:
            raise RuntimeRefusal("PATH_MAPPING_REQUIRED", "Bridge root must be an absolute Linux path")
        translated = run_bytes(["wsl.exe", "--distribution", distribution, "--exec", "/usr/bin/wslpath", "-w", root])
        if translated.returncode:
            raise RuntimeRefusal("PATH_MAPPING_REQUIRED", "WSL could not resolve the root mapping")
        native = io_path(Path(translated.stdout.decode("utf-8").rstrip("\r\n")), force=True)
        local_identity = root_identity(native)
        remote = transport({"root": root, "operation": "mapping.probe"})
        if not remote.get("ok"):
            return remote
        mapping = {"version": 1, "distribution": distribution, "executable": executable, "entry": entry,
                   "native": local_identity, "linux": remote["identity"], "environment_id": remote["environment_id"], "project_id": remote.get("project_id")}
        path = io_path(Path(mapping_file), force=True) if mapping_file else native / ".claude" / "mission-pipeline" / "bridge-mappings" / (digest([distribution, root, entry, executable]) + ".json")
        if path.exists():
            old = read_json_bytes(path.read_bytes())
            if old != mapping:
                raise RuntimeRefusal("ROOT_MAPPING_MISMATCH", "Registered filesystem, environment or ledger root changed; register a new mapping explicitly")
        elif mapping["project_id"]:
            atomic_bytes(path, json_bytes(mapping))
        elif request.get("operation") != "init":
            raise RuntimeRefusal("V4_INITIALIZATION_REQUIRED", "Initialize the mapped ledger before registering requests")
        if request.get("project_id") and request["project_id"] != mapping["project_id"]:
            raise RuntimeRefusal("ROOT_MAPPING_MISMATCH", "Request project differs from the registered root")
        def translate(value):
            if isinstance(value, dict):
                value = dict(value)
                if "relative_segments" in value and "root_id" in value:
                    if value["root_id"] not in (mapping["native"]["root_id"], mapping["linux"]["root_id"]):
                        raise RuntimeRefusal("ROOT_MAPPING_MISMATCH", "PathRef is outside the registered bridge mapping")
                    value["root_id"] = mapping["linux"]["root_id"]
                return {key: translate(item) for key, item in value.items()}
            return [translate(item) for item in value] if isinstance(value, list) else value
        request = translate(request)
        request.update(root_id=mapping["linux"]["root_id"], target_environment=mapping["environment_id"] if request.get("operation") != "maintenance" else request.get("target_environment"))
        if mapping["project_id"]:
            request["project_id"] = mapping["project_id"]
        # The owner environment can change through the fenced maintenance protocol;
        # the mapping pins the WSL execution environment, not the current writer.
        response = transport(request)
        if request.get("operation") == "init" and response.get("ok", True) and not mapping["project_id"]:
            mapping["project_id"] = transport({"root": root, "operation": "mapping.probe"})["project_id"]
            atomic_bytes(path, json_bytes(mapping))
        return response
    return transport(request)


def serve_one():
    from .engine import Engine
    from .workflow import Actor
    request = read_json_bytes(sys.stdin.buffer.read(8 * 1024 * 1024 + 1))
    if not isinstance(request, dict):
        raise RuntimeRefusal("INVALID_INPUT", "Bridge request must be an object")
    if request.get("role") == "controller":
        raise RuntimeRefusal("ROLE_FORBIDDEN", "controller is the executor's internal identity")
    if request.get("action") == "bridge.echo":
        from .environment import environment_id
        return {"ok": True, "data": request["data"], "platform": sys.platform, "environment_id": environment_id()}
    root = request.get("root")
    if not isinstance(root, str) or not root.startswith("/"):
        raise RuntimeRefusal("PATH_MAPPING_REQUIRED", "Bridge root must be an explicitly registered WSL absolute path")
    actor = Actor(request.get("role", "pm"), "bridge-local:" + request.get("role", "pm"))
    from .paths import root_identity
    engine = Engine(root, actor)
    operation = request.get("operation", "request")
    identity = root_identity(engine.root)
    if operation == "mapping.probe":
        from .environment import environment_id
        owner = read_json_bytes(engine.store.owner_path.read_bytes()) if engine.store.owner_path.exists() else {}
        return {"ok": True, "identity": identity, "environment_id": environment_id(), "project_id": owner.get("project")}
    if request.get("root_id") and request["root_id"] != identity["root_id"]:
        raise RuntimeRefusal("ROOT_MAPPING_MISMATCH", "Mapped filesystem root was replaced before the request")
    if operation == "init":
        return engine.store.initialize()
    identity = read_json_bytes(engine.store.owner_path.read_bytes()) if request.get("project_id") else {}
    if request.get("project_id") and identity["project"] != request["project_id"]:
        raise RuntimeRefusal("ROOT_MAPPING_MISMATCH", "Mapped root is a different ledger project")
    if operation == "maintenance":
        return engine.store.maintenance(request["maintenance"], request.get("target_environment"))
    if operation == "status":
        return engine.store.inspect()
    if operation.startswith("managed."):
        from .managed import ManagedBroker
        broker = ManagedBroker(engine)
        if operation == "managed.start":
            return broker.start()
        if operation == "managed.principal":
            return broker.principal(request["request"])
        if operation == "managed.run":
            # This is a trusted console transport, never a role-visible tool.
            config = read_json_bytes(Path(request["driver_config"]).read_bytes())
            if config.get("parallel_host_tools", True):
                raise RuntimeRefusal("UNSUPPORTED_HOST_TOOL_ACCESS", "Driver exposes unrestricted parallel tools")
            seat = broker.job_seat(request["job"], request.get("repair")) if request.get("job") else broker.seat(request["role"], request["mission"])
            return broker.run_driver(seat, config["argv"])
        raise RuntimeRefusal("UNKNOWN_ACTION", "Unknown managed bridge operation")
    return engine.handle(request["request"])


def main(argv):
    p = argparse.ArgumentParser(prog="mp bridge")
    p.add_argument("direction", choices=["wsl"])
    p.add_argument("--request-file")
    p.add_argument("--stdio", action="store_true")
    p.add_argument("--distribution", default="Ubuntu")
    p.add_argument("--executable", default="/usr/bin/python3")
    p.add_argument("--entry", required=True)
    p.add_argument("--mapping-file", help="Persist and verify the exact Windows/WSL filesystem and ledger binding")
    args = p.parse_args(argv)
    raw = Path(args.request_file).read_bytes() if args.request_file else sys.stdin.buffer.read()
    result = call_wsl(read_json_bytes(raw), args.distribution, args.executable, args.entry, args.mapping_file)
    sys.stdout.buffer.write(json_bytes(result))
    return 0 if result.get("ok", True) else 3
