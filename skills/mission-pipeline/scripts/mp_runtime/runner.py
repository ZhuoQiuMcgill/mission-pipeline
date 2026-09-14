"""Frozen explicit inputs and a real, allowlisted bubblewrap executor.

Managed execution is contained (bubblewrap, no network, allowlisted mounts) and is
recorded as "controller-execution". Local execution freezes the declared inputs,
captures logs and outputs and binds them to the run, but it does NOT contain the
process: it is recorded as "local-execution" and never claims containment.
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import subprocess
import time
from pathlib import Path

from .environment import clean_env, inspect_environment, PROBE, environment_id
from .paths import resolve_ref, contained, relative_path, io_path, execution_directory, display_path
from .process import RuntimeRefusal, run_bytes, json_bytes
from .workflow import Actor


def sandbox_argv(work, output, argv, cwd="/work", runtime_root=None):
    if os.name == "nt" or not shutil.which("bwrap"):
        raise RuntimeRefusal("HOST_ISOLATION_UNAVAILABLE", "Managed execution requires the WSL/Linux bubblewrap runner")
    command = [shutil.which("bwrap"), "--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]
    for path in ("/usr", "/lib", "/lib64"):
        if Path(path).exists():
            command += ["--ro-bind", path, path]
    command += ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev",
                "--tmpfs", "/tmp", "--ro-bind", str(work), "/work", "--bind", str(output), "/out",
                "--chdir", cwd, "--setenv", "PATH", "/usr/bin:/bin",
                "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--setenv", "PYTHONIOENCODING", "utf-8"]
    command += ["--setenv", "MP_OUTPUT_DIR", "/out"]
    if runtime_root:
        runtime_root = Path(runtime_root).absolute()
        if not (runtime_root / "pyvenv.cfg").is_file() or not (runtime_root / "bin/python").is_file():
            raise RuntimeRefusal("INVALID_RUNTIME_ROOT", "A managed extra runtime must be a specific Linux venv root")
        command += ["--ro-bind", str(runtime_root), "/runtime"]
    return command + ["--"] + argv


def capability_probe():
    with tempfile.TemporaryDirectory(prefix="mp-sandbox-probe-") as td:
        root = Path(td)
        work, output = root / "work", root / "out"
        work.mkdir()
        output.mkdir()
        command = sandbox_argv(work, output, ["/usr/bin/python3", "-c",
                    "import os,json; print(json.dumps({'pid':os.getpid(),'cwd':os.getcwd(),'home_visible':os.path.exists('/home'),'mnt_visible':os.path.exists('/mnt')}))"])
        result = run_bytes(command, timeout=30)
        if result.returncode:
            raise RuntimeRefusal("HOST_ISOLATION_UNAVAILABLE", "Allowlisted sandbox capability probe failed")
        return {"ok": True, "probe": result.stdout.decode("utf-8"), "mount_policy": "allowlist-v1"}


def inspect_managed_environment(executable, work, modules, project_modules, values, runtime_root=None, cwd="/work"):
    """Even module discovery executes untrusted code: use the actual sandbox."""
    clean_env(values)
    executable = str(Path(executable).absolute())
    sandbox_executable = executable
    if runtime_root:
        relative = Path(executable).relative_to(Path(runtime_root).absolute())
        sandbox_executable = "/runtime/" + relative.as_posix()
    elif not str(Path(executable).resolve()).startswith("/usr/"):
        raise RuntimeRefusal("EXECUTOR_OUTSIDE_RUNTIME", "Managed interpreter must belong to the trusted /usr runtime")
    with tempfile.TemporaryDirectory(prefix="mp-preflight-") as td:
        empty = Path(td) / "empty"
        empty.mkdir()
        output = Path(td) / "out"
        output.mkdir()
        command = sandbox_argv(work or empty, output, [sandbox_executable, "-c", PROBE], cwd=cwd, runtime_root=runtime_root)
        at = command.index("--")
        command[at:at] = [part for key, value in (values or {}).items() for part in ("--setenv", key, str(value))]
        result = run_bytes(command, input_bytes=json_bytes(modules), timeout=30)
        if result.returncode:
            raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Isolated interpreter preflight failed")
        try:
            record = json.loads(result.stdout.decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Isolated import probe returned invalid output") from exc
        for name, module in record["modules"].items():
            if "error" in module:
                raise RuntimeRefusal("MISSING_DEPENDENCY", "Required sandbox import failed", module=name)
            if name in project_modules and not (module.get("origin") or "").startswith("/work/"):
                raise RuntimeRefusal("IMPORT_OUTSIDE_TARGET", "Project module was not imported from frozen inputs", module=name)
        record["writer_environment_id"] = environment_id()
        record["relevant_env"] = {k: str(v) for k, v in (values or {}).items()}
        record["runtime_sha256"] = hashlib.sha256(Path(executable).read_bytes()).hexdigest()
        return record


def execute(engine, data):
    if engine.actor.role not in ("constructor", "crititor", "stabilizer"):
        # run.execute is dispatched before any workflow role check and then substitutes the
        # internal executor identity; the requesting seat is checked here instead.
        raise RuntimeRefusal("ROLE_FORBIDDEN", "Only a constructor, crititor or stabilizer seat starts a verification run")
    requirement = engine.object("requirement", data["requirement"])
    profile = engine.object("environment", requirement["environment"])
    state = engine.store.read()
    managed = state.get(("config", "project"), {}).get("data", {}).get("mode") == "managed"
    actor = Actor("controller", "executor:" + engine.actor.session, engine.actor.authenticated)
    executor = engine.with_actor(actor)
    executor.mutate("run.authorize", {"requirement": requirement["id"], "admission": data["admission"]}, data["request_id"] + ":authorize")
    with tempfile.TemporaryDirectory(prefix="mp-execution-") as temp:
        stage = Path(temp)
        work, output = stage / "work", stage / "out"
        work.mkdir()
        output.mkdir()
        inputs = []
        output_heads = {}
        for item in requirement.get("outputs", []):
            dest = resolve_ref(engine.root, item["destination"])
            output_heads[json_bytes(item["destination"])] = hashlib.sha256(dest.read_bytes()).hexdigest() if dest.exists() else None
        for ref in requirement["inputs"]:
            source = resolve_ref(engine.root, ref, must_exist=True)
            if contained(source, engine.store.path) or contained(source, engine.root / ".claude") or contained(source, engine.root / ".git"):
                raise RuntimeRefusal("PRIVATE_INPUT_FORBIDDEN", "Runtime private state cannot be declared as product input")
            if not source.is_file() or source.is_symlink():
                raise RuntimeRefusal("INVALID_EXECUTION_INPUT", "Execution inputs must be regular files inside the source root")
            rel = relative_path(source, engine.root)
            raw = source.read_bytes()
            blob = engine.store.blobs.put(raw)
            target = io_path(work / rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            inputs.append({"path": rel.as_posix(), "blob": blob})
        manifest = engine.store.blobs.put(json_bytes(inputs))
        from .paths import root_identity as resolve_root_identity
        bound_root_id = resolve_root_identity(engine.root)["root_id"]
        execution_cwd = resolve_ref(work, requirement.get("cwd", "."), root_id=bound_root_id)
        execution_cwd.mkdir(parents=True, exist_ok=True)
        from .paths import source_manifest
        try:
            source_identity = source_manifest(engine.root, engine.store.path)
        except RuntimeRefusal as exc:
            if exc.code != "GIT_ERROR":
                raise
            source_identity = {"kind": "explicit-inputs-without-git"}
        root_identity = str(display_path(engine.root).resolve())
        if os.name == "nt":
            root_identity = root_identity.casefold()
        source_record = engine.store.blobs.put(json_bytes({"input_blob": manifest, "source": source_identity,
                         "execution_root_identity": hashlib.sha256(root_identity.encode("utf-8", "surrogatepass")).hexdigest()}))
        # Preflight the selected interpreter, not the default 'python' alias.
        if profile.get("canonical"):
            from .canonical import inspect, prepare
            environment = inspect(profile["canonical"], engine.root)
            canonical_argv, canonical_env = prepare(profile["canonical"], work, output, stage)
            effective = stage / "canonical-compose.json"
            if effective.exists():
                normalized = effective.read_text(encoding="utf-8").replace(str(work).replace("\\", "\\\\"), "{work}").replace(str(output).replace("\\", "\\\\"), "{out}")
                environment["effective_config_blob"] = engine.store.blobs.put(normalized.encode("utf-8"))
        elif managed:
            environment = inspect_managed_environment(profile["executable"], work,
                         profile.get("modules", []), profile.get("project_modules", []), profile.get("values", {}), profile.get("runtime_root"),
                         "/work/" + execution_cwd.relative_to(work).as_posix())
        else:
            environment = inspect_environment(profile["executable"], execution_cwd,
                         profile.get("modules", []), profile.get("project_modules", []), profile.get("values", {}))
            environment["cwd"] = "frozen-input-root/" + execution_cwd.relative_to(work).as_posix()
            environment.pop("digest", None)
            for module in environment["modules"].values():
                if module.get("origin") and contained(module["origin"], work):
                    module["origin"] = "frozen-input-root/" + relative_path(module["origin"], work).as_posix()
        if environment["version"] != profile["version"]:
            raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Actual interpreter version differs from the registered canonical profile")
        environment_blob = engine.store.blobs.put(json_bytes(environment))
        begin = executor.mutate("run.begin", dict(requirement=requirement["id"], admission=data["admission"],
                    source_blob=source_record, input_blob=manifest, environment_blob=environment_blob,
                    purpose=data.get("purpose"), reason=data.get("reason"), deadline_seconds=data.get("timeout", 3600)),
                    data["request_id"] + ":begin")
        # A durable begin receipt is immutable; its embedded RUNNING object is
        # historical after finish. Return the actual current run on request retry.
        run = engine.object("run", begin["run"]["id"])
        if run.get("failure_code"):
            raise RuntimeRefusal(run["failure_code"], run["failure_detail"], run=run["id"], terminal=True)
        if begin.get("reused") or begin.get("pending"):
            if run["status"] == "COMPLETE" and run["satisfied"] and run.get("outputs_blob"):
                deliveries = [r for (kind, _), r in engine.store.read().items() if kind == "delivery" and r["data"].get("run") == run["id"]]
                if not deliveries:
                    exports = json.loads(engine.store.blobs.get(run["outputs_blob"]))
                    begin["export"] = executor.mutate("run.export", {"run":run["id"], "outputs":exports}, data["request_id"] + ":export")
            if run["status"] == "RUNNING" and run["lease_until"] <= time.time():
                takeover = executor.mutate("run.begin", dict(requirement=requirement["id"], admission=data["admission"],
                    source_blob=source_record, input_blob=manifest, environment_blob=environment_blob,
                    deadline_seconds=data.get("timeout", 3600)), data["request_id"] + ":takeover")
                run = engine.object("run", takeover["run"]["id"])
                if takeover.get("reused") or takeover.get("pending"):
                    return dict(takeover, run=run, pending=run["status"] == "RUNNING")
            else:
                return dict(begin, run=run, pending=run["status"] == "RUNNING")
        failed_stdout, failed_stderr = b"", b""
        result = None
        try:
            argv = list(requirement["argv"])
            if argv[0] in ("python", "python3", "{python}"):
                argv[0] = profile["executable"]
            env = clean_env(profile.get("values", {}))
            env["MP_OUTPUT_DIR"] = str(output)
            if profile.get("canonical"):
                argv, env = canonical_argv, canonical_env
            elif managed:
                if profile.get("runtime_root") and argv[0] == profile["executable"]:
                    argv[0] = "/runtime/" + Path(profile["executable"]).relative_to(Path(profile["runtime_root"])).as_posix()
                argv = sandbox_argv(work, output, argv, "/work/" + execution_cwd.relative_to(work).as_posix(), profile.get("runtime_root"))
                # Values are inserted as data arguments before --, never shell text.
                position = argv.index("--")
                additions = []
                for key, value in profile.get("values", {}).items():
                    additions += ["--setenv", key, str(value)]
                argv[position:position] = additions
            timeout = min(data.get("timeout", 3600), 86400)
            deadline = time.monotonic() + timeout
            heartbeat = time.monotonic() + 60
            with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file, execution_directory(execution_cwd) as process_cwd:
                child = subprocess.Popen(argv, cwd=process_cwd, env=env, stdin=subprocess.DEVNULL,
                                         stdout=stdout_file, stderr=stderr_file, shell=False, close_fds=True)
                try:
                    while child.poll() is None:
                        if time.monotonic() >= deadline:
                            child.kill()
                            child.wait()
                            stdout_file.seek(0)
                            stderr_file.seek(0)
                            failed_stdout, failed_stderr = stdout_file.read(), stderr_file.read()
                            raise RuntimeRefusal("EXECUTION_TIMEOUT", "Execution total deadline elapsed")
                        if time.monotonic() >= heartbeat:
                            executor.mutate("run.heartbeat", {"run": run["id"], "generation": run["generation"]},
                                            data["request_id"] + ":heartbeat:" + str(int(heartbeat)))
                            heartbeat = time.monotonic() + 60
                        try:
                            child.wait(timeout=min(1, max(0.01, deadline - time.monotonic())))
                        except subprocess.TimeoutExpired:
                            pass
                    stdout_file.seek(0)
                    stderr_file.seek(0)
                    result = subprocess.CompletedProcess(argv, child.returncode, stdout_file.read(), stderr_file.read())
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
            for item in inputs:
                path = work / item["path"]
                if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != item["blob"]:
                    raise RuntimeRefusal("SOURCE_CHANGED_DURING_RUN", "Executed input changed during verification")
            stdout = engine.store.blobs.put(result.stdout)
            stderr = engine.store.blobs.put(result.stderr)
            checks = {}
            if requirement["predicate"]["kind"] == "check_set":
                try:
                    checks = json.loads(result.stdout.decode("utf-8")).get("checks", {})
                except (ValueError, UnicodeError, AttributeError):
                    pass
            exports = []
            for item in requirement.get("outputs", []):
                artifact = resolve_ref(output, item["path"], root_id=bound_root_id)
                if artifact.is_file() and not artifact.is_symlink():
                    exports.append(dict(destination=item["destination"], source_blob=engine.store.blobs.put(artifact.read_bytes()),
                                        expected_sha256=output_heads[json_bytes(item["destination"])]))
            outputs_blob = engine.store.blobs.put(json_bytes(exports)) if exports and len(exports) == len(requirement.get("outputs", [])) else None
            finished = executor.mutate("run.finish", dict(run=run["id"], generation=run["generation"],
                        stdout_blob=stdout, stderr_blob=stderr, exit_code=result.returncode,
                        result="pass" if result.returncode == 0 else "fail", checks=checks, outputs_blob=outputs_blob), data["request_id"] + ":finish")
            if finished.get("run", {}).get("satisfied") and requirement.get("outputs"):
                finished["export"] = executor.mutate("run.export", {"run": run["id"], "outputs": exports}, data["request_id"] + ":export")
            return finished
        except (OSError, subprocess.SubprocessError, RuntimeRefusal) as exc:
            code = exc.code if isinstance(exc, RuntimeRefusal) else "EXECUTION_ERROR"
            detail = str(exc)
            executor.mutate("run.abort", dict(run=run["id"], generation=run["generation"], code=code, detail=detail,
                    stdout_blob=engine.store.blobs.put(result.stdout if result else failed_stdout),
                    stderr_blob=engine.store.blobs.put(result.stderr if result else failed_stderr)), data["request_id"] + ":abort")
            raise RuntimeRefusal(code, detail, run=run["id"], terminal=True) from exc
