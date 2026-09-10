"""R3 actual-product calibration validity, without acceptance bookkeeping cycles."""
import base64
import hashlib
import json
import os
import subprocess
import sys
import unittest
from v4_support import ROOT, Fixture, refuses
from mp_runtime.managed import ManagedBroker
from mp_runtime.storage import digest


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture(managed=True)
        self.addCleanup(self.f.close)
        self.f.broker = ManagedBroker(self.f.engine)
        self.f.broker.start()
        self.f.setup()
        task = self.f.engine.object("task", "t")
        self.f.call("pm", "task.record", **dict(task, revises=digest(task), recovers=True))
        self.f.review_admit()

    def changed_product(self):
        f = self.f
        before = (f.root / "verify.py").read_bytes()
        raw = before.replace(b"A usable report from controlled product execution", b"A usable report B with materially different actual contents")
        blob = f.broker.tool(f.seats["constructor"], {"tool": "submit_blob", "base64": base64.b64encode(raw).decode()})["blob"]
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py", source_blob=blob,
               expected_sha256=hashlib.sha256(before).hexdigest())
        return blob

    def close_mission(self):
        f = self.f
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], outcome="PASS", source_blob=f.blob)["review"]
        result = f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"], review=review["id"],
                        closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("CLOSED", result["status"])
        return result

    def test_old_aligned_rejects_real_B_then_actual_read_new_cell_accept_consume_close(self):
        f = self.f
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        original_task = digest(f.engine.object("task", "t"))
        cell_a = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "calibration")
        old_accept = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "report" and v["data"]["kind"] == "acceptance")
        new_blob = self.changed_product()
        self.assertNotIn(new_blob, f.seats["calibrator"]["read_blobs"])
        refuses(self, "TASK_CALIBRATION_REQUIRED", lambda: f.accept(round=2, calibrate=False))
        self.assertTrue(f.run["satisfied"])
        self.assertIn("report B", (f.root / "report.txt").read_text())
        self.assertEqual(original_task, digest(f.engine.object("task", "t")))
        refuses(self, "STALE_DEPENDENCY", lambda: f.call("pm", "consume", admission=f.admission))
        self.assertEqual(cell_a, f.engine.object("calibration", cell_a["id"]))
        bundle = f.call("pm", "bundle.record", mission="m", target="t", items=[])["bundle"]
        self.assertIn(new_blob, [x["blob"] for x in bundle["items"]])
        # Public role tools must read B's actual code and output, not only a new hash.
        seat = f.broker.seat("calibrator", "m")
        packet = f.broker.packet(seat)
        request = {"request_id": "calibrator-B", "action": "calibration.record", "data": {
            "bundle": bundle["id"], "task": "t", "wave": 1, "outcome": "ALIGNED", "source_blob": f.blob}}
        for blob in packet["input_manifest"]:
            if blob != new_blob:
                f.broker.tool(seat, {"tool": "read_blob", "blob": blob})
        refuses(self, "INPUT_NOT_READ", lambda: f.broker.tool(seat, {"tool": "submit", "request": request}))
        raw = f.broker.tool(seat, {"tool": "read_blob", "blob": new_blob})
        self.assertIn(b"materially different", base64.b64decode(raw["base64"]))
        cell_b = f.broker.tool(seat, {"tool": "submit", "request": request})["calibration"]
        self.assertNotEqual(cell_a["dependency_digest"], cell_b["dependency_digest"])
        critique = next(v["data"] for (k, _), v in f.engine.store.read().items()
                        if k == "report" and v["data"]["kind"] == "critique" and v["data"]["current"])
        accepted = f.call("stabilizer", "report.record", task="t", kind="acceptance", outcome="ACCEPTED", admission=f.admission,
                         source_blob=old_accept["source_blob"], criteria={"o": "met"}, round=2, revises=old_accept["id"], critique=critique["id"])
        self.assertEqual(cell_b["id"], accepted["report"]["calibration"])
        consume = f.call("pm", "consume", admission=f.admission)
        self.assertTrue(consume["committed"])
        print("R3_CURRENT_CALIBRATION " + json.dumps({"old_cell": cell_a["id"], "new_cell": cell_b,
               "accepted": accepted, "consume": consume, "close": self.close_mission()}, sort_keys=True))

    def test_annotation_accept_consume_and_unrelated_task_do_not_invalidate(self):
        f = self.f
        f.accept()
        report = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "report" and v["data"]["kind"] == "development")
        f.call("constructor", "report.record", task="t", kind="development", outcome="COMPLETE", source_blob=report["source_blob"],
               criteria={"o": "met"}, revises=report["id"], round=1, annotation_blob=f.blob)
        f.call("pm", "task.record", id="unrelated", mission="m", obligations=["o"], grant="g", domain="method",
               effects=[], allowed_effects=[], inputs=[f.blob], source_blob=f.blob, outputs=[], write_paths=[])
        f.call("pm", "decision.record", mission="m", grant="g", domain="method", tasks=["unrelated"],
               effects={"format": "html"}, rationale_blob=f.blob, choice="unrelated task method")
        for _ in range(2):
            self.assertTrue(f.call("pm", "consume", admission=f.admission)["committed"])
        self.assertEqual(1, len([k for k, _ in f.engine.store.read() if k == "calibration"]))

    def test_related_output_environment_and_authority_revoke_current_qualification(self):
        f = self.f
        f.accept()
        original = (f.root / "report.txt").read_bytes()
        (f.root / "report.txt").write_bytes(b"changed outside captured output")
        refuses(self, "STALE_EXECUTION_OUTPUT", lambda: f.call("pm", "consume", admission=f.admission))
        (f.root / "report.txt").write_bytes(original)
        f.call("pm", "consume", admission=f.admission)
        # A changed requirement/profile cannot borrow the old cell even when bytes return.
        # Actual authoritative state change uses a fresh registered profile + requirement API.
        f.call("principal", "environment.register", id="env2", executable=sys.executable, cwd=str(f.root), values={"PYTHONHASHSEED": "11"})
        req = f.engine.object("requirement", "r")
        # A second required run is a legal new task requirement, not a database mutation.
        f.call("pm", "requirement.record", id="r2", task="t", argv=req["argv"], inputs=req["inputs"], environment="env2", outputs=req["outputs"])
        refuses(self, "STALE_ADMISSION", lambda: f.call("pm", "consume", admission=f.admission))
        f.call("principal", "grant.revoke", grant="g", source_blob=f.blob)
        refuses(self, "AUTHORITY_CONFLICT", lambda: f.call("pm", "consume", admission=f.admission))


if __name__ == "__main__":
    if os.name == "nt":
        root = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:]
        raise SystemExit(subprocess.run(["wsl", "-d", "Ubuntu", "--cd", root, "--exec", "/usr/bin/python3", "tests/m20_current_calibration.py"]).returncode)
    unittest.main(verbosity=2)
