"""Schema-4 CLI. Requests are JSON data, never reconstructed shell commands."""
import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import sys
import uuid
from pathlib import Path

from .engine import Engine
from .environment import inspect_environment
from .markdown import document_fields
from .process import RuntimeRefusal, read_json_bytes, json_bytes
from .workflow import Actor


def root_path():
    if os.environ.get("MP_ROOT"):
        return Path(os.environ["MP_ROOT"]).resolve()
    from .process import git_text
    try:
        return Path(git_text(["rev-parse", "--show-toplevel"]).strip()).resolve()
    except RuntimeRefusal:
        return Path.cwd().resolve()


def parser():
    p = argparse.ArgumentParser(prog="mp", description="Mission Pipeline 2: scoped authority, evidence and supervised execution")
    p.add_argument("--json", action="store_true", help="Machine output (all v4 output is JSON)")
    p.add_argument("--actor", default=os.environ.get("MP_ACTOR", "pm"))
    p.add_argument("--session", help="Local provenance only; this is not managed authentication")
    p.add_argument("--root")
    p.add_argument("command", nargs="?", default="status")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    return p


def request_args(rest):
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--request-file")
    p.add_argument("--stdio", action="store_true")
    p.add_argument("--id")
    a, extra = p.parse_known_args(rest)
    if a.request_file:
        value = read_json_bytes(Path(a.request_file).read_bytes())
    elif a.stdio:
        value = read_json_bytes(sys.stdin.buffer.read(8 * 1024 * 1024 + 1))
    else:
        raise RuntimeRefusal("REQUEST_REQUIRED", "Supply --request-file or --stdio; commands are structured JSON, not shell strings")
    if not isinstance(value, dict):
        raise RuntimeRefusal("INVALID_INPUT", "Request body must be a JSON object")
    return value, a, extra


def output(value):
    sys.stdout.buffer.write(json_bytes(value))
    sys.stdout.buffer.flush()


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if sys.version_info < (3, 12):
            raise RuntimeRefusal("UNSUPPORTED_PYTHON", "The v4 runtime requires Python 3.12 or newer")
        from .paths import io_path
        root = io_path(Path(args.root).resolve() if args.root else root_path(), force=True)
        engine = Engine(root, Actor(args.actor, args.session or "local:" + args.actor))
        command, rest = args.command, args.rest
        if command == "init":
            result = engine.store.initialize()
            if ("config", "project") not in engine.store.read():
                result = engine.with_actor(Actor("principal", "local:init")).mutate(
                    "project.configure", {"mode": "local"}, "project-config-initial")
            output(dict(result, version="2.0.0", schema=4, mode="local", assurance="self-asserted"))
            return 0
        if command == "capabilities":
            import shutil
            from .paths import root_identity
            output({"ok": True, "version": "2.0.0", "schema": 4, "interpreter": sys.executable,
                    "execution_root": root_identity(root),
                    "python_version": list(sys.version_info[:3]), "platform": sys.platform,
                    "bwrap_binary_available": bool(shutil.which("bwrap")), "managed_ready": "requires successful managed probe and trusted driver",
                    "local": "data/workflow checks; no role authentication",
                    "managed": "Linux/WSL controller, private endpoint and bwrap; no parallel unrestricted host tools",
                    "commands": ["init", "api", "seal", "query", "blob", "doctor", "rebuild", "migrate", "rollback", "maintenance", "render", "relay", "env", "bridge", "managed"],
                    "actions": sorted(name[3:].replace("_", ".") for name in dir(__import__("mp_runtime.workflow", fromlist=["Workflow"]).Workflow)
                                      if name.startswith("do_")), "retry": {"deterministic": 0, "transient": 2}})
            return 0
        if command == "env":
            verb = rest[0] if rest and rest[0] in ("inspect", "validate", "create", "canonical") else "inspect"
            data, _, _ = request_args(rest[1:] if rest and rest[0] == verb else rest)
            if verb == "create":
                from .environment import create_environment
                output(create_environment(**data))
            elif verb == "canonical":
                from .environment import canonical_command
                prepared = canonical_command(data["profile"], data["root"])
                output({"ok": True, "argv": prepared["argv"], "cwd": prepared["cwd"], "clean_environment": True})
            else:
                output(inspect_environment(**data))
            return 0
        if command == "bridge":
            from .bridge import main as bridge_main
            return bridge_main(rest)
        if command == "managed":
            from .managed import main as managed_main
            return managed_main(engine, rest)
        if command == "migrate":
            from .migration import adoption_plan, migrate
            p = argparse.ArgumentParser()
            p.add_argument("--source-root", default=str(root))
            p.add_argument("--plan", action="store_true")
            m = p.parse_args(rest)
            plan = adoption_plan(engine.store.path, m.source_root)
            if m.plan:
                output(plan)
            else:
                output(migrate(engine.store, plan, engine.actor))
            return 0
        if command == "rollback":
            from .migration import rollback
            output(rollback(engine.store))
            return 0
        if command == "maintenance":
            p = argparse.ArgumentParser(prog="mp maintenance")
            p.add_argument("operation", choices=["recover", "quiesce", "handoff", "accept"])
            p.add_argument("--target-environment")
            m = p.parse_args(rest)
            output(engine.store.maintenance(m.operation, m.target_environment))
            return 0
        if not engine.store.manifest_path.exists():
            raise RuntimeRefusal("V4_INITIALIZATION_REQUIRED", "Initialize schema 4 or migrate the existing legacy ledger")
        if command in ("status", "inspect"):
            output(engine.store.inspect())
        elif command == "doctor":
            result = engine.store.doctor()
            result["semantic"] = [{"artifact": row["data"]["artifact"], "status": row["data"]["status"]}
                                  for (kind, _), row in engine.store.read().items() if kind == "semantic_overlay"]
            result["workflow"] = [row["data"] for (kind, _), row in engine.store.read().items()
                                  if kind == "barrier" and row["data"]["phase"] != "RELEASED"]
            output(result)
        elif command == "rebuild":
            output(engine.store.rebuild())
        elif command == "blob":
            if not rest or rest[0] not in ("put", "get") or len(rest) != 2:
                raise RuntimeRefusal("INVALID_INPUT", "Use blob put <file> or blob get <sha256>")
            if rest[0] == "put":
                raw = Path(rest[1]).read_bytes()
                output({"ok": True, "blob": engine.store.blobs.put(raw), "bytes": len(raw)})
            else:
                raw = engine.store.blobs.get(rest[1])
                output({"ok": True, "blob": rest[1], "base64": base64.b64encode(raw).decode("ascii")})
        elif command in ("query", "worklist", "acts"):
            kind = rest[0] if rest else None
            output(engine.handle({"action": "query", "data": {"kind": kind, "id": rest[1] if len(rest) > 1 else None}}))
        elif command == "render":
            from .field_adapter import publish
            output(publish(engine))
        elif command == "relay":
            from .field_adapter import relay
            if len(rest) != 1:
                raise RuntimeRefusal("INVALID_INPUT", "relay requires the mission id")
            output(relay(engine, rest[0]))
        elif command == "seal":
            if len(rest) != 1:
                raise RuntimeRefusal("INVALID_INPUT", "seal takes one document containing an mp-json request")
            raw = Path(rest[0]).read_bytes()
            fields = document_fields(raw)
            text = raw.decode("utf-8-sig")
            match = re.search(r"```mp-json\s*\n(.*?)\n```", text, re.S)
            if not match:
                raise RuntimeRefusal("V4_DOCUMENT_REQUIRED", "Use the v2 template's mp-json block; legacy seal cannot bypass root review or admission")
            request = read_json_bytes(match[1].encode("utf-8"))
            request.setdefault("request_id", "seal-" + hashlib.sha256(raw).hexdigest())
            request.setdefault("data", {})["source_blob"] = engine.store.blobs.put(raw)
            output(engine.handle(request))
        elif command == "api":
            request, _, _ = request_args(rest)
            output(engine.handle(request))
        else:
            # Familiar two-word verbs are aliases to the SAME transition service.
            sub = rest[0] if rest and not rest[0].startswith("--") else None
            action = command + ("." + sub if sub else "")
            request, _, _ = request_args(rest[1:] if sub else rest)
            if request.get("action") not in (None, action):
                raise RuntimeRefusal("ACTION_MISMATCH", "Request action differs from the command")
            request["action"] = action
            output(engine.handle(request))
        return 0
    except RuntimeRefusal as exc:
        output(exc.body())
        return 3
    except sqlite3.Error as exc:
        output({"ok": False, "code": "DATABASE_UNAVAILABLE", "detail": str(exc), "recovery": "Use maintenance recover or rebuild after restoring the ledger inputs"})
        return 3
    except (OSError, ValueError, KeyError, TypeError) as exc:
        output({"ok": False, "code": "INVALID_INPUT", "detail": str(exc)})
        return 3
