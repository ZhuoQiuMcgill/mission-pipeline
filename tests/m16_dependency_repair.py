import base64
import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from v4_support import refuses
from mp_runtime.environment import create_environment, inspect_environment
from mp_runtime.process import run_bytes


class DependencyRepairTests(unittest.TestCase):
    def test_missing_dependency_locked_local_install_then_actual_import(self):
        with tempfile.TemporaryDirectory(prefix="mp-locked-deps-") as td:
            root = Path(td)
            wheels = root / "wheels"
            wheels.mkdir()
            wheel = wheels / "local_verification_dep-1.0-py3-none-any.whl"
            dist = "local_verification_dep-1.0.dist-info/"
            files = {"local_verification_dep.py": b"VALUE=23\n__version__='1.0'\n",
                     dist + "METADATA": b"Metadata-Version: 2.1\nName: local-verification-dep\nVersion: 1.0\n",
                     dist + "WHEEL": b"Wheel-Version: 1.0\nGenerator: isolated-acceptance\nRoot-Is-Purelib: true\nTag: py3-none-any\n"}
            record = "".join(name + ",sha256=" + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=") + "," + str(len(raw)) + "\n" for name, raw in files.items())
            files[dist + "RECORD"] = (record + dist + "RECORD,,\n").encode()
            with zipfile.ZipFile(wheel, "w") as archive:
                for name, raw in files.items():
                    archive.writestr(name, raw)
            lock = root / "requirements.lock"
            lock.write_text("local-verification-dep==1.0 --hash=sha256:" + hashlib.sha256(wheel.read_bytes()).hexdigest() + "\n", encoding="utf-8")
            empty = create_environment(sys.executable, root / "missing", root)
            refuses(self, "MISSING_DEPENDENCY", lambda: inspect_environment(empty["executable"], root, ["local_verification_dep"]))
            restored = create_environment(sys.executable, root / "restored", root, ["local_verification_dep"],
                                          dependency_lock="requirements.lock", wheelhouse="wheels")
            self.assertEqual(hashlib.sha256(lock.read_bytes()).hexdigest(), restored["dependency_lock_sha256"])
            self.assertTrue(Path(restored["modules"]["local_verification_dep"]["origin"]).is_relative_to(root / "restored"))
            run = run_bytes([restored["executable"], "-c", "import local_verification_dep;assert local_verification_dep.VALUE==23;print('PASS real installed dependency')"], cwd=root)
            self.assertEqual(0, run.returncode, run.stderr)
            self.assertIn(b"PASS real installed dependency", run.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
