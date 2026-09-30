"""Build the release asset dist/mission-pipeline-skill-v<version>.zip from the git index.

The archive contains exactly the tracked files under skills/mission-pipeline, rooted at
`mission-pipeline/`, byte-identical to the git tree (no bytecode, no working-tree noise).
The version comes from the packaged tree's .claude-plugin/plugin.json and must match
the working manifest and packaged runtime. Run from anywhere inside the repository.
"""
import ast
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
tree = subprocess.check_output(["git", "write-tree"], cwd=ROOT, text=True).strip()


def tree_bytes(path):
    return subprocess.check_output(["git", "show", tree + ":" + path], cwd=ROOT)


VERSION = json.loads(tree_bytes(".claude-plugin/plugin.json").decode("utf-8"))["version"]
working_version = json.loads((ROOT / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
if working_version != VERSION:
    raise SystemExit(f"Version mismatch: working manifest is {working_version}, packaged tree is {VERSION}; stage the intended release metadata first")
runtime_source = ast.parse(tree_bytes("skills/mission-pipeline/scripts/mp_runtime/__init__.py").decode("utf-8"))
runtime_versions = [ast.literal_eval(node.value) for node in runtime_source.body
                    if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "VERSION"
                                                           for target in node.targets)]
if runtime_versions != [VERSION]:
    raise SystemExit(f"Version mismatch: packaged runtime VERSION is {runtime_versions}, manifest is {VERSION}")
entries = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", tree + ":skills/mission-pipeline"],
                                  cwd=ROOT, text=True).splitlines()
assert all("__pycache__" not in p and not p.endswith(".pyc") for p in entries), "bytecode in tree"
required = ["SKILL.md", "scripts/mp", "scripts/mp.ps1", "scripts/mp_runtime/__init__.py",
            "scripts/mp_runtime/cli.py", "scripts/mp_runtime/workflow.py", "roles/supervisor.md", "references/setup.md"]
if int(VERSION.split(".", 1)[0]) >= 3:
    required.extend(["scripts/mp_runtime/fast.py", "roles/secretary.md", "references/fast-mode.md", "templates/receipt-task.md"])
missing = sorted(set(required) - set(entries))
if missing:
    raise SystemExit("Packaged tree is missing required files: " + ", ".join(missing))
OUT = ROOT / "dist"
OUT.mkdir(exist_ok=True)
archive = OUT / f"mission-pipeline-skill-v{VERSION}.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for p in entries:
        raw = tree_bytes("skills/mission-pipeline/" + p)
        info = zipfile.ZipInfo("mission-pipeline/" + p, (2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (0o100755 if p == "scripts/mp" else 0o100644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, raw)
with zipfile.ZipFile(archive) as z:
    files = {n for n in z.namelist() if not n.endswith("/")}
    assert files == {"mission-pipeline/" + p for p in entries}
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(OUT / "SHA256SUMS.txt").write_text(digest + "  " + archive.name + "\n", encoding="utf-8")
print(json.dumps({"version": VERSION, "tree": tree, "asset": str(archive), "sha256": digest, "files": len(entries)}))
sys.exit(0)
