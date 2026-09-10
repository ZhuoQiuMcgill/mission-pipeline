"""Execution environment provenance; never dumps ambient secrets."""
import hashlib
import json
import os
import platform
import shutil
import sys
from pathlib import Path

from .process import RuntimeRefusal, json_bytes, run_bytes
from .paths import contained, io_path, display_path

RELEVANT_ENV = ("PYTHONHASHSEED", "LANG", "LC_ALL", "TZ", "PYTHONUTF8")
BASE_ENV = ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "PATH", "PATHEXT")
PROBE = """import importlib,json,os,platform,sys,hashlib
names=json.loads(sys.stdin.buffer.read().decode('utf-8'))
result={'executable':sys.executable,'version':list(sys.version_info[:3]),'prefix':sys.prefix,'base_prefix':sys.base_prefix,'cwd':os.path.realpath(os.getcwd()),'platform':sys.platform,'arch':platform.machine(),'modules':{}}
for name in names:
 try:
  m=importlib.import_module(name)
  origin=getattr(m,'__file__',None)
  sha=hashlib.sha256(open(origin,'rb').read()).hexdigest() if origin and os.path.isfile(origin) else None
  origin=os.path.realpath(origin) if origin else None
  result['modules'][name]={'origin':origin,'version':getattr(m,'__version__',None),'sha256':sha}
 except ImportError as e:
  result['modules'][name]={'error':str(e)}
print(json.dumps(result,ensure_ascii=True))
"""


def environment_id():
    # An identity of the writer platform, not role authentication.
    distro = os.environ.get("WSL_DISTRO_NAME", "")
    return hashlib.sha256(json_bytes([platform.node(), sys.platform, distro])).hexdigest()[:24]


def clean_env(values=None):
    values = values or {}
    if any(k not in RELEVANT_ENV for k in values):
        raise RuntimeRefusal("INVALID_ENV", "Only explicit non-secret execution variables are accepted")
    env = {k: os.environ[k] for k in BASE_ENV if k in os.environ}
    env.update({"PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"})
    env.update({k: str(v) for k, v in values.items()})
    return env


def inspect_environment(executable=None, cwd=None, modules=None, project_modules=None, values=None):
    executable = executable or sys.executable
    actual = shutil.which(executable) if not Path(executable).is_absolute() else executable
    if not actual or not Path(actual).is_file():
        raise RuntimeRefusal("EXECUTOR_UNAVAILABLE", "Interpreter is unavailable")
    cwd = io_path(Path(cwd or os.getcwd()).resolve())
    if not cwd.is_dir():
        raise RuntimeRefusal("INVALID_CWD", "Execution cwd does not exist")
    p = run_bytes([str(Path(actual).absolute()), "-c", PROBE], cwd=cwd,
                  env=clean_env(values), input_bytes=json_bytes(modules or []))
    if p.returncode:
        raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Interpreter preflight failed")
    try:
        record = json.loads(p.stdout.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise RuntimeRefusal("ENVIRONMENT_MISMATCH", "Interpreter did not return a valid probe") from exc
    for name, module in record["modules"].items():
        if "error" in module:
            raise RuntimeRefusal("MISSING_DEPENDENCY", "Required import failed", module=name,
                                 repair="Create a fresh local venv from the project dependency manifest")
        if name in (project_modules or []) and (not module["origin"] or not contained(module["origin"], cwd)):
            raise RuntimeRefusal("IMPORT_OUTSIDE_TARGET", "Imported module is outside the judged source", module=name)
    record["writer_environment_id"] = environment_id()
    record["runtime_sha256"] = hashlib.sha256(Path(actual).read_bytes()).hexdigest()
    record["relevant_env"] = {k: str(v) for k, v in (values or {}).items()}
    record["digest"] = hashlib.sha256(json_bytes(record)).hexdigest()
    return record


def create_environment(executable, target, cwd, modules=None, project_modules=None, dependency_lock=None, wheelhouse=None):
    """Create a fresh environment locally; copied activation paths are never repaired in place."""
    target = io_path(Path(target).absolute())
    if target.exists():
        raise RuntimeRefusal("ENVIRONMENT_EXISTS", "Choose a new empty environment path; existing environments are preserved")
    result = run_bytes([str(Path(executable).absolute()), "-m", "venv", "--without-pip", str(target)],
                       cwd=Path(cwd).resolve(), env=clean_env(), timeout=120)
    if result.returncode:
        raise RuntimeRefusal("ENVIRONMENT_CREATION_FAILED", "The selected interpreter could not create a fresh venv")
    python = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    dependency_digest = None
    if dependency_lock:
        from .paths import resolve_ref
        if not wheelhouse:
            raise RuntimeRefusal("DEPENDENCY_SOURCE_REQUIRED", "Supply the declared local wheelhouse; no guessed package or global installation is attempted")
        lock = resolve_ref(cwd, dependency_lock, must_exist=True)
        wheels = resolve_ref(cwd, wheelhouse, must_exist=True)
        dependency_digest = hashlib.sha256(lock.read_bytes()).hexdigest()
        bootstrap = run_bytes([str(python), "-m", "ensurepip", "--upgrade"], cwd=cwd, env=clean_env(), timeout=120)
        if bootstrap.returncode:
            raise RuntimeRefusal("DEPENDENCY_TOOL_UNAVAILABLE", "This selected interpreter needs its ensurepip component provisioned")
        installed = run_bytes([str(python), "-m", "pip", "install", "--require-hashes", "--no-index", "--no-cache-dir",
                               "--disable-pip-version-check", "--find-links", str(wheels), "-r", str(lock)],
                              cwd=cwd, env=clean_env(), timeout=120)
        if installed.returncode:
            raise RuntimeRefusal("DEPENDENCY_INSTALL_FAILED", "Locked local dependencies could not be installed; preserve this failed environment and correct the lock/source")
    result = inspect_environment(str(python), cwd, modules or [], project_modules or [])
    result["dependency_lock_sha256"] = dependency_digest
    return result


def canonical_command(profile, root):
    """A registered argv/cwd/environment is the entire execution contract."""
    from .paths import resolve_ref
    from .process import validate_argv
    argv = validate_argv(profile["argv"])
    cwd = resolve_ref(root, profile.get("cwd", "."), must_exist=True)
    for path in profile.get("build_contexts", []) + profile.get("bind_sources", []):
        resolve_ref(root, path, must_exist=True)
    environment = clean_env(profile.get("values", {}))
    # Compose files are fixed argv values. Ambient COMPOSE_FILE/PYTHONPATH never enter.
    if profile.get("compose_file"):
        compose = resolve_ref(root, profile["compose_file"], must_exist=True)
        if "-f" not in argv or str(compose) not in argv:
            raise RuntimeRefusal("CANONICAL_PROFILE_MISMATCH", "Compose profile must use its exact explicit -f file")
    return {"argv": argv, "cwd": str(cwd), "environment": environment}
