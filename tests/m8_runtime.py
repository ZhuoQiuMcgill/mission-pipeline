import copy
import json
import unittest
from v4_support import Fixture, refuses
from mp_runtime.process import RuntimeRefusal


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)

    def test_authorized_lifecycle_and_current_input(self):
        f = self.f
        f.setup()
        f.accept()
        self.assertTrue(f.run["satisfied"])
        f.call("pm", "consume", admission=f.admission)
        (f.root / "verify.py").write_text("print('changed')\n", encoding="utf-8")
        refuses(self, "STALE_EXECUTION_INPUT", lambda: f.call("crititor", "report.record", kind="critique", task="t", outcome="PASS", admission=f.admission, source_blob=f.blob, criteria={"o": "met"}))

    def test_pending_barrier_and_automatic_independent_contest(self):
        f = self.f
        f.setup()
        case = f.issue()
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        out = f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        self.assertEqual("PENDING", out["contest"]["status"])
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        f.call("pm", "task.dispatch", admission=f.admission)

    def test_recovery_verified_keeps_original_history(self):
        f = self.f
        f.setup()
        case = f.issue()
        f.call("supervisor", "issue.screen", case=case["id"], outcome="ESTABLISHED", source_blob=f.blob)
        permit = f.call("pm", "recovery.permit", case=case["id"], tasks=["t"])["permit"]
        f.review_admit(permit["id"])
        f.accept()
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "consume", admission=f.admission))
        out = f.call("supervisor", "case.resolve", case=case["id"], outcome="VERIFIED_FIXED", source_blob=f.blob,
                     repair_tasks=["t"], counterexample_eliminated=True)
        self.assertEqual("PENDING", out["contest"]["status"])
        out = f.call("stabilizer", "contest.decide", case=case["id"], outcome="REPAIR_VERIFIED", source_blob=f.blob,
                     repair_tasks=["t"], counterexample_eliminated=True)
        self.assertTrue(out["case"]["established"])
        self.assertFalse(out["supervisor_signature_required"])
        f.review_admit()
        f.call("pm", "consume", admission=f.admission)

    def test_durable_retry_and_tail_recovery(self):
        f = self.f
        actor = {"role": "principal", "session": "fault", "authenticated": False}
        request = dict(request_id="fault", action="test", data={})
        def write(state):
            state[("test", "one")] = dict(revision=0, data={"id": "one", "value": 1})
            return {"value": 1}
        def fail(name):
            if name == "after_fsync":
                raise OSError("simulated crash after durable append")
        f.engine.store.fault = fail
        refuses(self, "COMMIT_DURABLE_RECOVERY_REQUIRED", lambda: f.engine.store.transact(request, actor, write))
        f.engine.store.fault = None
        result = f.engine.store.transact(request, actor, write)
        self.assertTrue(result["reused"])
        segment = f.engine.store.path / f.engine.store.manifest()["segments"][-1]["path"]
        with segment.open("ab") as stream:
            stream.write(b'{"partial":')
        raw = segment.read_bytes()
        f.engine.store.transact(dict(request, request_id="next"), actor, write)
        self.assertEqual(raw, segment.read_bytes())
        self.assertTrue(f.engine.store.doctor()["ok"])

    def test_advisory_does_not_stop_work(self):
        f = self.f
        f.setup()
        f.call("constructor", "issue.report", mission="m", kind="ADVISORY", source_blob=f.blob, text="optional cosmetic suggestion")
        f.call("pm", "task.dispatch", admission=f.admission)

    def test_complete_closure_requires_current_full_bundle(self):
        f = self.f
        f.setup()
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="mission-close", items=[])["bundle"]
        self.assertGreater(len(bundle["items"]), 3)
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        result = f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"], review=review["id"], closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("CLOSED", result["status"])
        refuses(self, "MISSION_CLOSED", lambda: f.call("pm", "task.dispatch", admission=f.admission))


if __name__ == "__main__":
    unittest.main(verbosity=2)
