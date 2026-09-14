"""Build the release asset dist/mission-pipeline-skill-v<version>.zip from the git index.

The archive contains exactly the tracked files under skills/mission-pipeline, rooted at
`mission-pipeline/`, byte-identical to the git tree (no bytecode, no working-tree noise).
The version comes from .claude-plugin/plugin.json. Run from anywhere inside the repository.
"""
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
VERSION = json.loads((ROOT / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
OUT = ROOT / "dist"
OUT.mkdir(exist_ok=True)
tree = subprocess.check_output(["git", "write-tree"], cwd=ROOT, text=True).strip()
archive = OUT / f"mission-pipeline-skill-v{VERSION}.zip"
entries = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", tree + ":skills/mission-pipeline"],
                                  cwd=ROOT, text=True).splitlines()
assert all("__pycache__" not in p and not p.endswith(".pyc") for p in entries), "bytecode in tree"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for p in entries:
        raw = subprocess.check_output(["git", "show", tree + ":skills/mission-pipeline/" + p], cwd=ROOT)
        info = zipfile.ZipInfo("mission-pipeline/" + p, (2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (0o100755 if p == "scripts/mp" else 0o100644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, raw)
with zipfile.ZipFile(archive) as z:
    files = {n for n in z.namelist() if not n.endswith("/")}
    assert files == {"mission-pipeline/" + p for p in entries}
for required in ["SKILL.md", "scripts/mp", "scripts/mp.ps1", "scripts/mp_runtime/cli.py",
                 "scripts/mp_runtime/workflow.py", "roles/supervisor.md", "references/setup.md"]:
    assert required in entries, required
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(OUT / "SHA256SUMS.txt").write_text(digest + "  " + archive.name + "\n", encoding="utf-8")
print(json.dumps({"version": VERSION, "tree": tree, "asset": str(archive), "sha256": digest, "files": len(entries)}))
sys.exit(0)
