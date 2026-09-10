import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from v4_support import ROOT, Fixture, refuses
from mp_runtime.managed import ManagedBroker
from mp_runtime.process import json_bytes


class ManagedTests(unittest.TestCase):
    def test_real_managed_protocol_and_import_isolation(self):
        if os.name == "nt":
            # Native entry exercises the actual WSL transport, then the same restricted suite.
            root = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:]
            proc = subprocess.run(["wsl", "--distribution", "Ubuntu", "--cd", root, "--exec", "/usr/bin/python3", "tests/m10_managed.py"], capture_output=True)
            self.assertEqual(0, proc.returncode, proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace"))
            return
        f = Fixture(managed=True)
        self.addCleanup(f.close)
        broker = ManagedBroker(f.engine)
        probe = broker.start()
        self.assertEqual("allowlist-v1", probe["isolation"]["mount_policy"])
        f.broker = broker
        f.setup()
        host_only = f.root.parent / (f.root.name + "-host-only")
        host_only.mkdir()
        self.addCleanup(host_only.rmdir)
        marker = host_only / "marker"
        self.addCleanup(lambda: marker.unlink(missing_ok=True))
        (f.root / "evil.py").write_text(
            "from pathlib import Path\nblocked=False\ntry:\n Path(" + repr(str(marker)) + ").write_text('host escaped')\nexcept OSError:\n blocked=True\n", encoding="utf-8")
        (f.root / "verify_extra.py").write_text("import evil\nassert evil.blocked\nprint('PASS sandbox import really blocked')\n", encoding="utf-8")
        f.call("principal", "environment.register", id="env2", executable=sys.executable, cwd=str(f.root), modules=["evil"], project_modules=["evil"])
        self.assertFalse(marker.exists(), "Registration must not import project code on the host")
        f.call("pm", "requirement.record", id="r2", task="t", argv=["{python}", "verify_extra.py"], inputs=["verify_extra.py", "evil.py"], environment="env2")
        f.review_admit()
        constructor = broker.seat("constructor", "m", ["t"])
        packet = broker.packet(constructor)
        self.assertIn(f.blob, packet["input_manifest"])
        read = broker.tool(constructor, {"tool": "read_blob", "blob": f.blob})
        self.assertTrue(read["base64"])
        refuses(self, "TOOL_FORBIDDEN", lambda: broker.tool(constructor, {"tool": "shell", "command": "echo escape"}))
        refuses(self, "ROLE_FORBIDDEN", lambda: broker.tool(constructor, {"tool": "submit", "request": {"action": "grant.record", "request_id": "forged", "data": {}}}))
        run = broker.tool(constructor, {"tool": "submit", "request": dict(action="run.execute", request_id="isolated", data={"requirement": "r2", "admission": f.admission})})["run"]
        self.assertTrue(run["satisfied"], f.engine.store.blobs.get(run["stderr_blob"]).decode("utf-8", "replace"))
        self.assertEqual("controller-execution", run["assurance"])
        self.assertFalse(marker.exists(), "Neither import preflight nor execution may write the host")
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        closed = f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"], review=review["id"], closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("CLOSED", closed["status"])
        # An actual trusted stdio transport reads the role payload and a source blob.
        driver = f.root / "driver.py"
        driver.write_text("""import json,sys,base64
p=json.loads(sys.stdin.buffer.readline())['packet']
assert p['role']=='auditor' and p['instructions']
print(json.dumps({'tool_calls':[{'tool':'read_blob','blob':p['input_manifest'][0]}]}),flush=True)
r=json.loads(sys.stdin.buffer.readline())['tool_results'][0]
raw=base64.b64decode(r['result']['base64'])
print(json.dumps({'final_document':'Read actual immutable input: '+str(len(raw))+' bytes; '+p['role']}),flush=True)
""", encoding="utf-8")
        result = broker.run_driver(broker.seat("auditor", "m"), [sys.executable, str(driver)])
        self.assertIn("Read actual immutable input", result["final_document"])
        sleeper = f.root / "sleeper.py"
        sleeper.write_text("import time; time.sleep(5)\n", encoding="utf-8")
        refuses(self, "DRIVER_DEADLINE", lambda: broker.run_driver(broker.seat("auditor", "m"), [sys.executable, str(sleeper)], timeout=0.1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
