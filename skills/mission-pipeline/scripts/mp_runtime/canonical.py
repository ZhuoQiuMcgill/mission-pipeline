"""Pinned, principal-registered external executors; never a model shell tool.

The external executor is a trusted host component, like the model transport.
Its contract is explicit argv plus frozen / work and output paths. It has a
different assurance label from bubblewrap; registering it does not claim that
an arbitrary host executable becomes sandboxed.
"""
import hashlib
import json
from pathlib import Path
from .environment import clean_env, environment_id
from .paths import contained, resolve_ref
from .process import RuntimeRefusal, validate_argv, run_bytes, json_bytes
from .storage import digest, atomic_bytes


def executable_manifest(argv, files, root):
    argv = validate_argv(argv)
    if not Path(argv[0]).is_absolute():
        raise RuntimeRefusal("CANONICAL_PROFILE_MISMATCH", "External executor must be an absolute trusted executable")
    if Path(argv[0]).name.lower().startswith("python") and any(x in ("-m", "-c") for x in argv[1:]):
        raise RuntimeRefusal("UNTRUSTED_EXTERNAL_EXECUTOR", "A Python external executor must be an installed pinned script, not ambient module discovery")
    paths = set([argv[0]] + files + [x for x in argv[1:] if Path(x).is_absolute() and Path(x).is_file()])
    result = []
    for name in sorted(paths):
        path = Path(name).absolute()
        if not path.is_file() or contained(path, root):
            raise RuntimeRefusal("UNTRUSTED_EXTERNAL_EXECUTOR", "Executor files must be installed outside the writable product tree")
        result.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return result


def register(data, root, blobs):
    kind = data.get("kind", "command")
    if kind not in ("command", "compose"):
        raise RuntimeRefusal("UNSUPPORTED_EXECUTION_KIND", "Canonical executor kind must be command or compose")
    argv = validate_argv(data["executor_argv"])
    manifest = executable_manifest(argv, data.get("executor_files", []), root)
    clean_env(data.get("values", {}))
    probe = run_bytes(argv + data.get("version_args", ["--version"]), cwd=root,
                      env=clean_env(data.get("values", {})), timeout=30)
    if probe.returncode:
        raise RuntimeRefusal("EXECUTOR_UNAVAILABLE", "Canonical executor version probe failed; provision this executor before registering")
    expected = data.get("expected_version")
    if not expected or expected.encode("utf-8") not in probe.stdout:
        raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Canonical executor does not match its explicitly required version")
    command = validate_argv(data.get("command", [])) if kind == "command" else []
    profile = {"kind": kind, "executor_argv": argv, "executor_files": manifest,
               "version_args": data.get("version_args", ["--version"]), "version_blob": blobs.put(probe.stdout),
               "expected_version": expected, "command": command, "values": data.get("values", {}),
               "required_inputs": data.get("required_inputs", []), "service": data.get("service"),
               "compose_file": data.get("compose_file"), "writer_environment_id": environment_id()}
    if kind == "compose" and (not profile["compose_file"] or not profile["service"]):
        raise RuntimeRefusal("CANONICAL_PROFILE_MISMATCH", "Compose executor requires its fixed file and service")
    for ref in profile["required_inputs"]:
        resolve_ref(root, ref, must_exist=True)
    return profile


def inspect(profile, root):
    current = executable_manifest(profile["executor_argv"], [x["path"] for x in profile["executor_files"]], root)
    if current != profile["executor_files"] or profile["writer_environment_id"] != environment_id():
        raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Canonical executor bytes or host identity changed; register the verified replacement")
    result = run_bytes(profile["executor_argv"] + profile["version_args"], cwd=root,
                       env=clean_env(profile["values"]), timeout=30)
    if result.returncode or hashlib.sha256(result.stdout).hexdigest() != profile["version_blob"]:
        raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Canonical executor version changed")
    return {"kind": "canonical_profile_execution", "profile_digest": digest(profile),
            "version": profile["expected_version"], "executor_files": current,
            "writer_environment_id": environment_id(), "relevant_env": profile["values"]}


def prepare(profile, work, output, stage):
    env = clean_env(profile["values"])
    substitutions = {"{work}": str(work), "{out}": str(output)}
    if profile["kind"] == "command":
        # Whole argv elements are replaced; user strings are never formatted or shell joined.
        return profile["executor_argv"] + [substitutions.get(x, x) for x in profile["command"]], env
    compose = resolve_ref(work, profile["compose_file"], must_exist=True)
    from .runner import sandbox_argv
    sandbox_executor = list(profile["executor_argv"])
    mounts = []
    for index, item in enumerate(profile["executor_files"]):
        if not contained(item["path"], "/usr"):
            target = "/executor/" + str(index)
            mounts += ["--ro-bind", item["path"], target]
            sandbox_executor = [target if arg == item["path"] else arg for arg in sandbox_executor]
    inside_file = "/work/" + compose.relative_to(work).as_posix()
    base = sandbox_executor + ["compose", "--project-directory", "/work", "-f", inside_file, "config", "--format", "json"]
    sandbox = sandbox_argv(work, output, base)
    at = sandbox.index("--")
    sandbox[at:at] = mounts
    # Configuration parsing itself sees only frozen inputs: env_file/include or
    # interpolation cannot read host credentials before the resolved check.
    rendered = run_bytes(sandbox, env=env, timeout=30)
    if rendered.returncode:
        raise RuntimeRefusal("CANONICAL_PROFILE_MISMATCH", "Explicit frozen Compose configuration could not be resolved")
    try:
        config = json.loads(rendered.stdout)
        service = config["services"][profile["service"]]
    except (ValueError, KeyError, TypeError) as exc:
        raise RuntimeRefusal("CANONICAL_PROFILE_MISMATCH", "Resolved Compose service is missing or invalid") from exc
    forbidden = ("privileged", "devices", "cap_add", "volumes_from", "use_api_socket", "provider", "develop", "post_start", "pre_stop")
    if any(service.get(k) for k in forbidden) or any(service.get(k) == "host" for k in ("network_mode", "pid", "ipc", "userns_mode")):
        raise RuntimeRefusal("CANONICAL_EFFECT_CONFLICT", "Compose service requests unregistered host privileges")
    def source_path(value):
        try:
            relative = Path(value).relative_to("/work")
        except (ValueError, TypeError):
            raise RuntimeRefusal("CANONICAL_EFFECT_CONFLICT", "Resolved source is outside the frozen namespace")
        return resolve_ref(work, str(relative), must_exist=True)
    for bind in service.get("volumes", []):
        if not isinstance(bind, dict) or bind.get("type") != "bind":
            raise RuntimeRefusal("CANONICAL_EFFECT_CONFLICT", "Compose source mounts must be frozen declared inputs")
        bind["source"] = str(source_path(bind.get("source")))
        bind["read_only"] = True
    build = service.get("build")
    if build:
        if not isinstance(build, dict) or build.get("additional_contexts") or build.get("ssh") or build.get("secrets"):
            raise RuntimeRefusal("CANONICAL_EFFECT_CONFLICT", "Compose build context escapes frozen inputs")
        build["context"] = str(source_path(build.get("context")))
        build["network"] = "none"
    if service.get("configs") or service.get("secrets") or service.get("env_file"):
        raise RuntimeRefusal("CANONICAL_EFFECT_CONFLICT", "Resolved external config/secret mounts are outside this execution contract")
    service.pop("depends_on", None)
    service.pop("networks", None)
    service.pop("ports", None)
    service.update(network_mode="none", read_only=True)
    service.setdefault("volumes", []).append({"type": "bind", "source": str(output), "target": "/out"})
    service.setdefault("environment", {})["MP_OUTPUT_DIR"] = "/out"
    effective = stage / "canonical-compose.json"
    atomic_bytes(effective, json_bytes({"services": {profile["service"]: service}}))
    return profile["executor_argv"] + ["compose", "--project-directory", str(work), "-f", str(effective), "run", "--rm", "--no-deps", "-T", profile["service"]], env
