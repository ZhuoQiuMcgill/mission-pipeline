import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from v4_support import ROOT, Fixture, refuses
from mp_runtime.process import run_bytes, json_bytes
from mp_runtime.paths import source_manifest, resolve_ref, contained, root_identity
from mp_runtime.markdown import document_fields
from mp_runtime.field_adapter import readonly_query, snapshot, publish
from mp_runtime.environment import environment_id, create_environment, inspect_environment, canonical_command, clean_env


class EnvironmentTests(unittest.TestCase):
    def test_argv_json_and_byte_identity(self):
        values = ["", "space name", "报告🙂", "`backtick`", "$(not a command)", "'single'", '"double"', "trailing\\", "line1\nline2", "[x]"]
        script = "import sys,json; print(json.dumps({'argv':sys.argv[1:],'json':json.loads(sys.stdin.buffer.read().decode('utf-8'))},ensure_ascii=True))"
        response = run_bytes([sys.executable, "-c", script] + values, input_bytes=json_bytes(values))
        self.assertEqual({"argv": values, "json": values}, json.loads(response.stdout))
        f = Fixture()
        self.addCleanup(f.close)
        crlf, lf = b"first\r\nsecond\r\n", b"first\nsecond\n"
        self.assertNotEqual(f.engine.store.blobs.put(crlf), f.engine.store.blobs.put(lf))
        refuses(self, "INVALID_PATH", lambda: resolve_ref(f.root, "D:relative"))
        refuses(self, "PATH_OUTSIDE_SCOPE", lambda: resolve_ref(f.root, "../escape"))
        ref = {"root_id": root_identity(f.root)["root_id"], "relative_segments": ["verify.py"], "origin_platform": sys.platform}
        self.assertEqual(f.root / "verify.py", resolve_ref(f.root, ref))
        refuses(self, "ROOT_MAPPING_MISMATCH", lambda: resolve_ref(f.root, dict(ref, root_id="another-root")))
        refuses(self, "INVALID_UTF8", lambda: document_fields(b"\xff"))

    def test_native_utf8_off_on_special_git_names(self):
        with tempfile.TemporaryDirectory(prefix="mp-git-字符串-") as td:
            root = Path(td)
            def git(*args):
                p = run_bytes(["git"] + list(args), cwd=root)
                self.assertEqual(0, p.returncode, p.stderr)
            git("init", "-q")
            path = root / "报告🙂 空格 $() ` [x].txt"
            path.write_bytes(b"baseline")
            git("add", ".")
            git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
            hashes = []
            module_path = str(ROOT / "skills/mission-pipeline/scripts")
            probe = "import sys,json;sys.path.insert(0,sys.argv[1]);from mp_runtime.paths import source_manifest;print(json.dumps(source_manifest(sys.argv[2])))"
            for mode in ("0", "1"):
                results = []
                for raw in (b"change A", b"change B"):
                    path.write_bytes(raw)
                    env = dict(os.environ, PYTHONUTF8=mode, PYTHONIOENCODING="cp1252")
                    p = run_bytes([sys.executable, "-X", "utf8=" + mode, "-c", probe, module_path, td], env=env)
                    self.assertEqual(0, p.returncode, p.stderr)
                    results.append(json.loads(p.stdout)["tree_hash"])
                self.assertNotEqual(*results)
                hashes.append(results)
            self.assertEqual(*hashes)

    def test_typed_root_refs_execute_frozen_inputs_and_reject_wrong_tree(self):
        f = Fixture()
        self.addCleanup(f.close)
        f.setup()
        identity = root_identity(f.root)["root_id"]
        f.call("pm", "requirement.record", id="typed", task="t", argv=["{python}", "verify.py"],
               inputs=[{"root_id": identity, "relative_segments": ["verify.py"], "origin_platform": sys.platform}],
               cwd={"root_id": identity, "relative_segments": []}, environment="env",
               outputs=[{"path": {"root_id": identity, "relative_segments": ["report.txt"]}, "destination": {"root_id": identity, "relative_segments": ["report.txt"]}}])
        f.review_admit()
        run = f.call("constructor", "run.execute", requirement="typed", admission=f.admission)["run"]
        self.assertTrue(run["satisfied"])
        self.assertTrue((f.root / "report.txt").read_bytes().startswith(b"A usable report"))
        f.call("pm", "requirement.record", id="wrong-tree", task="t", argv=["{python}", "verify.py"],
               inputs=[{"root_id": "unrelated-root", "relative_segments": ["verify.py"]}], environment="env")
        f.review_admit()
        refuses(self, "ROOT_MAPPING_MISMATCH", lambda: f.call("constructor", "run.execute", requirement="wrong-tree", admission=f.admission))

    def test_readonly_adapter_and_stale_publication(self):
        f = Fixture()
        self.addCleanup(f.close)
        old = snapshot(f.engine)
        f.setup()
        publish(f.engine)
        refuses(self, "VIEW_STALE", lambda: publish(f.engine, old))
        rows = readonly_query(f.engine.store, "SELECT count(*) FROM runtime_events")
        self.assertGreater(rows["rows"][0][0], 1)
        refuses(self, "READ_QUERY_REJECTED", lambda: readonly_query(f.engine.store, "DELETE FROM runtime_objects"))
        self.assertTrue(f.engine.store.doctor()["ok"])

    def test_actual_windows_wsl_bridge(self):
        if os.name != "nt":
            # WSL still validates the exact stdio service; Windows suite tests wsl.exe.
            entry = ROOT / "skills/mission-pipeline/scripts/mp"
            value = {"action": "bridge.echo", "data": ["中文", "a\nb", "$(x)", "`x`", "\\", ""]}
            p = run_bytes([sys.executable, str(entry), "--bridge-stdio"], input_bytes=json_bytes(value))
            self.assertEqual(value["data"], json.loads(p.stdout)["data"])
            return
        entry = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:] + "/skills/mission-pipeline/scripts/mp"
        literal = ["中文🙂 空格", '"quotes"', "`tick`", "$(do not run)", "\\tail\\", "\r\n", ""]
        request = {"action": "bridge.echo", "data": literal}
        mp = str(ROOT / "skills/mission-pipeline/scripts/mp")
        p = run_bytes([sys.executable, mp, "bridge", "wsl", "--stdio", "--entry", entry], input_bytes=json_bytes(request))
        self.assertEqual(0, p.returncode, p.stderr)
        self.assertEqual(literal, json.loads(p.stdout)["data"])

    def test_real_owner_handoff_and_fenced_old_environment(self):
        f = Fixture()
        self.addCleanup(f.close)
        if os.name != "nt":
            f.engine.store.maintenance("quiesce")
            refuses(self, "OWNER_QUIESCED", lambda: f.call("principal", "project.configure", mode="local"))
            f.engine.store.maintenance("recover")
            f.call("principal", "project.configure", mode="local")
            return
        f.setup()
        from mp_runtime.bridge import call_wsl
        entry = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:] + "/skills/mission-pipeline/scripts/mp"
        mapped_root = "/mnt/" + f.root.drive[0].lower() + f.root.as_posix()[2:]
        remote = call_wsl({"action": "bridge.echo", "data": []}, entry=entry)["environment_id"]
        owner = f.engine.store.owner()
        f.engine.store.maintenance("handoff", remote)
        refuses(self, "OWNER_QUIESCED", lambda: f.call("principal", "project.configure", mode="local"))
        accepted = call_wsl({"root": mapped_root, "operation": "maintenance", "maintenance": "accept", "project_id": owner["project"]}, entry=entry)
        self.assertTrue(accepted.get("ok"), accepted)
        self.assertEqual(owner["epoch"] + 1, accepted["owner"]["epoch"])
        refuses(self, "WRITER_ENVIRONMENT_MISMATCH", lambda: f.call("principal", "project.configure", mode="local"))
        committed = call_wsl({"root": mapped_root, "project_id": owner["project"], "role": "principal", "request": dict(action="project.configure", request_id="wsl-write", data={"mode": "local"})}, entry=entry)
        self.assertTrue(committed.get("committed"), committed)
        registrations = list((f.root / ".claude" / "mission-pipeline" / "bridge-mappings").glob("*.json"))
        self.assertEqual(1, len(registrations))
        mapping = json.loads(registrations[0].read_bytes())
        self.assertEqual(owner["project"], mapping["project_id"])
        self.assertEqual(root_identity(f.root)["root_id"], mapping["native"]["root_id"])
        refuses(self, "ROOT_MAPPING_MISMATCH", lambda: call_wsl({"root": mapped_root, "project_id": "wrong-project", "operation": "status"}, entry=entry))
        refuses(self, "ROOT_MAPPING_MISMATCH", lambda: call_wsl({"root": mapped_root, "request": {"action": "query", "data": {"path": {"root_id": "wrong-root", "relative_segments": []}}, "request_id": "wrong-path"}}, entry=entry))
        mapping["linux"]["root_id"] = "replaced-filesystem"
        registrations[0].write_bytes(json_bytes(mapping))
        refuses(self, "ROOT_MAPPING_MISMATCH", lambda: call_wsl({"root": mapped_root, "operation": "status"}, entry=entry))
        # Explicitly remove only this fixture's deliberately corrupted registration.
        registrations[0].unlink()
        def submit(role, action, data):
            result = call_wsl({"root": mapped_root, "role": role, "request": {"action": action, "data": data, "request_id": "bridge-" + action}}, entry=entry)
            self.assertTrue(result.get("ok", True), result)
            return result
        submit("principal", "environment.register", {"id": "wsl-env", "executable": "/usr/bin/python3", "cwd": mapped_root})
        native_id = root_identity(f.root)["root_id"]
        submit("pm", "requirement.record", {"id": "mapped-run", "task": "t", "argv": ["{python}", "verify.py"],
               "inputs": [{"root_id": native_id, "relative_segments": ["verify.py"], "origin_platform": "win32"}],
               "cwd": {"root_id": native_id, "relative_segments": []}, "environment": "wsl-env", "outputs": [{"path": "report.txt", "destination": "report.txt"}]})
        snapshot = submit("supervisor", "contracts.snapshot", {"mission": "m"})
        original_sources = {f.blob} | {row["object"]["source_blob"] for row in snapshot["records"] if row["object"].get("source_blob")}
        import base64
        for blob in original_sources:
            read = run_bytes(["wsl", "-d", "Ubuntu", "--exec", "/usr/bin/python3", entry,
                              "--root", mapped_root, "blob", "get", blob])
            self.assertEqual(0, read.returncode, read.stderr)
            raw = base64.b64decode(json.loads(read.stdout)["base64"])
            self.assertEqual(blob, hashlib.sha256(raw).hexdigest())
        review = submit("supervisor", "plan.review", {"plan": "p", "tasks": ["t"], "outcome": "PASS", "source_blob": f.blob,
                        "contract_scope_digest": snapshot["contract_scope_digest"]})["review"]
        admission = submit("pm", "task.admit", {"task": "t", "review": review["id"]})["admission"]
        execution = submit("constructor", "run.execute", {"requirement": "mapped-run", "admission": admission["id"]})
        self.assertTrue(execution["run"]["satisfied"])
        self.assertTrue((f.root / "report.txt").read_bytes().startswith(b"A usable report"))
        again = submit("constructor", "run.execute", {"requirement": "mapped-run", "admission": admission["id"]})
        self.assertEqual(execution["run"]["id"], again["run"]["id"])
        prepared = call_wsl({"root": mapped_root, "operation": "maintenance", "maintenance": "handoff", "target_environment": environment_id()}, entry=entry)
        self.assertTrue(prepared.get("ok"), prepared)
        f.engine.store.maintenance("accept")
        f.call("principal", "project.configure", mode="local")
        self.assertEqual(owner["epoch"] + 2, f.engine.store.owner()["epoch"])

    def test_fresh_venv_import_repair_canonical_cwd_and_secret_boundary(self):
        with tempfile.TemporaryDirectory(prefix="mp-venv-") as td:
            root = Path(td)
            current, old = root / "current", root / "old-worktree"
            current.mkdir()
            old.mkdir()
            (old / "owned_package.py").write_text("VALUE=1\n", encoding="utf-8")
            bad = create_environment(sys.executable, str(root / "bad-venv"), str(current))
            executable = bad["executable"]
            query = run_bytes([executable, "-c", "import sysconfig,json;print(json.dumps(sysconfig.get_path('purelib')))"])
            site = Path(json.loads(query.stdout))
            (site / "copied-origin.pth").write_text(str(old) + "\n", encoding="utf-8")
            refuses(self, "IMPORT_OUTSIDE_TARGET", lambda: inspect_environment(executable, current, ["owned_package"], ["owned_package"]))
            refuses(self, "MISSING_DEPENDENCY", lambda: inspect_environment(executable, current, ["mp_deliberately_missing_dependency"]))
            (current / "owned_package.py").write_text("VALUE=2\n", encoding="utf-8")
            fresh = create_environment(sys.executable, str(root / "fresh-venv"), str(current), ["owned_package"], ["owned_package"])
            self.assertTrue(Path(fresh["modules"]["owned_package"]["origin"]).is_relative_to(current))
            sentinel = "secret-never-export-8521"
            previous = {k: os.environ.get(k) for k in ("COMPOSE_FILE", "PYTHONPATH", "SENTINEL_SECRET")}
            try:
                os.environ.update(COMPOSE_FILE="wrong-compose.yml", PYTHONPATH=str(old), SENTINEL_SECRET=sentinel)
                profile = canonical_command({"argv": [fresh["executable"], "-c", "import os,json,owned_package;print(json.dumps([os.getcwd(),owned_package.VALUE,os.getenv('COMPOSE_FILE'),os.getenv('PYTHONPATH'),os.getenv('SENTINEL_SECRET')]))"], "cwd": "current"}, root)
                result = run_bytes(profile["argv"], cwd=profile["cwd"], env=profile["environment"])
                self.assertEqual([str(current), 2, None, None, None], json.loads(result.stdout))
                self.assertNotIn(sentinel, json.dumps(fresh))
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
            long = current.joinpath(*(["long-directory-" + "x" * 35] * 6), "中文.txt")
            long_io = resolve_ref(current, str(long))
            long_io.parent.mkdir(parents=True)
            long_io.write_bytes(b"long-path")
            try:
                self.assertGreater(len(str(long)), 260)
                self.assertEqual(b"long-path", resolve_ref(current, str(long), True).read_bytes())
            finally:
                long_io.unlink(missing_ok=True)
                directory = long_io.parent
                for _ in range(6):
                    directory.rmdir()
                    directory = directory.parent

    def test_seed_is_launch_identity_not_semantic_failure(self):
        program = "import json;print(json.dumps({'items':list(set(['alpha','beta','gamma','delta','epsilon','zeta','theta'])),'result':'pass'}))"
        outputs = []
        for seed in ("1", "2", "1"):
            result = run_bytes([sys.executable, "-c", program], env=clean_env({"PYTHONHASHSEED": seed}))
            self.assertEqual("pass", json.loads(result.stdout)["result"])
            outputs.append(result.stdout)
        self.assertEqual(outputs[0], outputs[2])
        self.assertNotEqual(outputs[0], outputs[1])

    def test_entire_long_ledger_and_readonly_sqlite_uri(self):
        from mp_runtime.storage import RuntimeStore
        from mp_runtime.paths import io_path
        import sqlite3
        with tempfile.TemporaryDirectory(prefix="mp-long-ledger-") as td:
            root = Path(td)
            path = io_path(root.joinpath(*(["segment-" + "x" * 55] * 5)), force=True)
            store = RuntimeStore(path)
            try:
                store.initialize()
                self.assertGreater(len(str(store.db_path)), 330)
                with store.connect(readonly=True) as conn:
                    with self.assertRaises(sqlite3.OperationalError):
                        conn.execute("CREATE TABLE forbidden(v)")
                conn.close()
                store.rebuild()
                self.assertTrue(store.doctor()["ok"])
                store.maintenance("quiesce")
                store.maintenance("recover")
                # The product root is long too: registration, frozen interpreter cwd,
                # controlled write, execution and export must all preserve that path.
                from mp_runtime.engine import Engine
                import itertools
                fixture = Fixture.__new__(Fixture)
                fixture.root = path / "long-product-root"
                fixture.root.mkdir()
                fixture.engine = Engine(fixture.root)
                fixture.engine.store.initialize()
                fixture.n = itertools.count()
                fixture.managed = False
                fixture.blob = fixture.engine.store.blobs.put(b"Principal: deliver a usable report; PM may choose and revise the method.")
                fixture.setup()
                fixture.accept()
                self.assertTrue(fixture.run["satisfied"])
                self.assertTrue((fixture.root / "report.txt").read_bytes().startswith(b"A usable report"))
                fixture.call("pm", "consume", admission=fixture.admission)
                self.assertTrue(fixture.engine.store.doctor()["ok"])
            finally:
                import shutil
                # Generated fixture only; the extended root preserves cleanup semantics.
                self.assertTrue(contained(path, root))
                shutil.rmtree(io_path(root, force=True))

    def test_real_worktree_same_commit_distinct_checkout_bytes(self):
        with tempfile.TemporaryDirectory(prefix="mp-worktree-") as td:
            parent = Path(td)
            repo, worktree = parent / "repo", parent / "中文 '$()` worktree"
            repo.mkdir()
            def git(*args):
                result = run_bytes(["git", *args], cwd=repo)
                self.assertEqual(0, result.returncode, result.stderr)
                return result.stdout
            git("init")
            (repo / "report.txt").write_bytes(b"same\n")
            git("add", "report.txt")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "isolated source")
            git("worktree", "add", "--detach", str(worktree), "HEAD")
            initial = source_manifest(repo)
            other = source_manifest(worktree)
            self.assertEqual(initial["commit_sha"], other["commit_sha"])
            (worktree / "report.txt").write_bytes(b"same\r\n")
            changed = source_manifest(worktree)
            self.assertEqual(initial["commit_sha"], changed["commit_sha"])
            self.assertNotEqual(initial["tree_hash"], changed["tree_hash"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
