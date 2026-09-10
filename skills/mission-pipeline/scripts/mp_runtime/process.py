"""Byte preserving subprocess and JSON transport. Never evaluates command text."""
import json
import os
import subprocess
import sys
from pathlib import Path


class RuntimeRefusal(Exception):
    def __init__(self, code, detail, **context):
        super().__init__(detail)
        self.code, self.detail, self.context = code, detail, context

    def body(self):
        return dict(ok=False, code=self.code, detail=self.detail, **self.context)


def utf8_console():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def read_json_bytes(raw, limit=8 * 1024 * 1024):
    if len(raw) > limit:
        raise RuntimeRefusal("INVALID_INPUT", "JSON request exceeds limit")
    try:
        def pairs(items):
            value = {}
            for key, item in items:
                if key in value:
                    raise ValueError("duplicate JSON key")
                value[key] = item
            return value
        def constant(_):
            raise ValueError("nonfinite JSON number")
        return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError) as exc:
        raise RuntimeRefusal("INVALID_INPUT", "Invalid UTF-8 JSON request") from exc


def validate_argv(argv):
    if not isinstance(argv, list) or not argv or any(
            not isinstance(a, str) or "\0" in a for a in argv):
        raise RuntimeRefusal("INVALID_INPUT", "argv must be a nonempty string array without NUL")
    if not argv[0]:
        raise RuntimeRefusal("INVALID_INPUT", "executable cannot be empty")
    return argv


def run_bytes(argv, cwd=None, env=None, input_bytes=None, timeout=120):
    validate_argv(argv)
    try:
        from .paths import execution_directory
        with execution_directory(cwd) as actual_cwd:
            return subprocess.run(argv, cwd=actual_cwd, env=env, input=input_bytes,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  shell=False, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeRefusal("EXECUTION_TIMEOUT", "Execution deadline exceeded") from exc
    except OSError as exc:
        raise RuntimeRefusal("EXECUTOR_UNAVAILABLE", str(exc), executable=argv[0]) from exc


def git_bytes(args, cwd=None):
    # Identity reads must not invoke repository-configured fsmonitor or clean
    # filters on the host before a managed run reaches its sandbox.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0")
    prefix = ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + os.devnull]
    filters = run_bytes(prefix + ["config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|process|required)$"], cwd=cwd, env=env)
    if filters.returncode not in (0, 1):
        raise RuntimeRefusal("GIT_ERROR", filters.stderr.decode("utf-8", "backslashreplace").strip())
    if filters.returncode == 0:
        for raw in filters.stdout.split(b"\0"):
            if raw:
                key = raw.decode("utf-8", "strict" if os.name == "nt" else "surrogateescape")
                prefix += ["-c", key + ("=false" if key.endswith(".required") else "=")]
    result = run_bytes(prefix + list(args), cwd=cwd, env=env)
    if result.returncode:
        raise RuntimeRefusal("GIT_ERROR", result.stderr.decode("utf-8", "backslashreplace").strip())
    return result.stdout


def git_text(args, cwd=None):
    return git_bytes(args, cwd).decode("utf-8", "surrogateescape" if os.name != "nt" else "strict")
