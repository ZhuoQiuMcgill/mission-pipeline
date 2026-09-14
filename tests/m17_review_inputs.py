"""R2: a delivered reading cannot be silently rebound to changed governance."""
import copy
import base64
import json
import os
import subprocess
import sys
import unittest
from v4_support import ROOT, Fixture, refuses
from mp_runtime.managed import ManagedBroker
from mp_runtime.workflow import Actor
from mp_runtime.storage import digest


class ReviewInputsTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.f.setup()

    def revised_task(self, blob):
        f = self.f
        f.call("pm", "task.record", id="t", mission="m", obligations=["o"], grant="g", domain="method",
               revises=digest(f.engine.object("task", "t")),
               effects=["write-report"], allowed_effects=["write-report"], inputs=[blob], source_blob=blob,
               write_paths=["verify.py"], outputs=["report.txt"])

    def read_packet(self, broker, seat):
        packet = broker.packet(seat)
        for blob in packet["input_manifest"]:
            broker.tool(seat, {"tool": "read_blob", "blob": blob})
        return packet

    def test_local_commit_checks_old_target_then_bounded_explicit_rebase(self):
        f = self.f
        case = f.issue(role="constructor")
        before = copy.deepcopy(case)
        data = dict(case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        old = dict(data, **f.engine.handle({"action": "review.snapshot", "data": data}))
        new = f.engine.store.blobs.put(b"PM chooses a revised method inside the same grant.")
        self.revised_task(new)
        engine = f.engine.with_actor(Actor("supervisor", "seat:supervisor"))
        refuses(self, "STALE_REVIEW_INPUT", lambda: engine.mutate("issue.screen", old, "old-reading"))
        self.assertEqual("PENDING_SCREEN", f.engine.object("barrier", case["id"])["phase"])
        refuses(self, "REVIEW_REBASE_REQUIRED", lambda: f.call("supervisor", "issue.screen", **data))
        f.call("supervisor", "review.rebase", case=case["id"])
        f.call("supervisor", "issue.screen", **data)
        final = f.engine.object("case", case["id"])
        self.assertEqual(before["target_digest"], final["target_digest"])
        self.assertEqual(before["fact"], final["fact"])
        self.assertEqual(1, len(final["review_rebases"]))
        f.review_admit()
        self.assertIn("ticket", f.call("pm", "task.dispatch", admission=f.admission))

    def test_managed_packet_does_not_launder_unread_revised_task(self):
        f = self.f
        case = f.issue(role="constructor")
        broker = ManagedBroker(f.engine)
        seat = broker.job_seat(case["id"] + ":screen")
        self.read_packet(broker, seat)
        request = {"action": "issue.screen", "request_id": "old-driver-dismiss",
                   "data": dict(case=case["id"], outcome="DISMISSED", source_blob=f.blob)}
        new = f.engine.store.blobs.put(b"Unread new authorized task source")
        self.revised_task(new)
        self.assertNotIn(new, seat["read_blobs"])
        refuses(self, "STALE_REVIEW_INPUT", lambda: broker.tool(seat, {"tool": "submit", "request": request}))
        self.assertNotIn(new, seat["read_blobs"])
        broker.tool(seat, {"tool": "refresh_packet"})
        refuses(self, "INPUT_NOT_READ", lambda: broker.tool(seat, {"tool": "submit", "request": request}))
        self.read_packet(broker, seat)
        rebase = {"action": "review.rebase", "request_id": "rebase", "data": {"case": case["id"]}}
        broker.tool(seat, {"tool": "submit", "request": rebase})
        # Rebase itself changes the case. The unseen result cannot refresh its reading.
        refuses(self, "STALE_REVIEW_INPUT", lambda: broker.tool(seat, {"tool": "submit", "request": request}))
        self.read_packet(broker, seat)
        result = broker.tool(seat, {"tool": "submit", "request": request})
        self.assertEqual("DISMISSED", result["case"]["status"])
        self.assertTrue(broker.tool(seat, {"tool": "submit", "request": request})["reused"])
        self.assertEqual(1, f.engine.object("budget", case["id"] + ":correction")["count"])
        self.assertEqual(1, f.engine.object("budget", case["lineage"] + ":correction_total")["count"])

    def test_case_authority_and_scoped_fence_changes_reject_but_unrelated_seq_does_not(self):
        f = self.f
        case = f.issue(role="constructor")
        data = dict(case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        engine = f.engine.with_actor(Actor("supervisor", "seat:supervisor"))
        old = dict(data, **engine.handle({"action": "review.snapshot", "data": data}))
        f.call("pm", "decision.record", id="unrelated", mission="m", grant="g", domain="method",
               effects={"format": "html"}, rationale_blob=f.blob, choice="unrelated authorized choice")
        f.call("principal", "grant.record", id="unrelated-domain", authority="a", source_blob=f.blob, scope="m",
               domains=["other-task-domain"], permissions=["choose"])
        engine.mutate("issue.screen", old, "unrelated-still-valid")
        # A late mandatory Auditor changes the same case and opens its contest.
        f.issue(role="auditor")
        stale = dict(case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        stale.update(engine.handle({"action": "review.snapshot", "data": stale}))
        f.call("principal", "grant.revoke", grant="g", source_blob=f.blob)
        stab = f.engine.with_actor(Actor("stabilizer", "seat:stabilizer"))
        refuses(self, "STALE_REVIEW_INPUT", lambda: stab.mutate("contest.decide", stale, "authority-stale"))
        self.assertEqual("CONTEST_PENDING", f.engine.object("barrier", case["id"])["phase"])
        f.call("stabilizer", "review.rebase", case=case["id"])
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)

    def test_rebase_budget_is_durable_and_does_not_change_original_identity(self):
        f = self.f
        case = f.issue(role="constructor")
        for i in range(2):
            self.revised_task(f.engine.store.blobs.put(("revision " + str(i)).encode()))
            f.call("supervisor", "review.rebase", case=case["id"])
        self.revised_task(f.engine.store.blobs.put(b"third revision"))
        # The third durable reading replaces the target instead of deadlocking the case.
        result = f.call("supervisor", "review.rebase", case=case["id"])
        successor = result["case"]
        self.assertEqual(case["id"], result["superseded"])
        self.assertNotEqual(case["id"], successor["id"])
        self.assertEqual(case["target_digest"], f.engine.object("case", case["id"])["target_digest"])
        self.assertEqual(2, len(f.engine.object("case", case["id"])["review_rebases"]))
        self.assertEqual("TARGET_REPLACED", f.engine.object("case", case["id"])["status"])
        self.assertEqual("RELEASED", f.engine.object("barrier", case["id"])["phase"])
        self.assertEqual(case["id"], successor["supersedes"])
        self.assertNotEqual(case["fact"], successor["fact"])
        self.assertEqual("PENDING_SCREEN", f.engine.object("barrier", successor["id"])["phase"])
        self.assertEqual("PENDING", f.engine.object("job", successor["id"] + ":screen")["status"])
        # The successor is still a real barrier; the same scope stays blocked until it resolves.
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        f.call("supervisor", "issue.screen", case=successor["id"], outcome="DISMISSED", source_blob=f.blob)
        f.review_admit()
        self.assertIn("ticket", f.call("pm", "task.dispatch", admission=f.admission))

    def test_all_case_release_and_scope_shrink_actions_check_the_delivered_revision(self):
        f = self.f
        case = f.issue(role="constructor")
        f.call("supervisor", "issue.screen", case=case["id"], outcome="ESTABLISHED", source_blob=f.blob)
        basis = f.engine.handle({"action": "review.snapshot", "data": {"case": case["id"]}})["review_basis"]
        # Late mandatory evidence changes this case but neither its target nor global authority.
        f.issue(role="auditor")
        for role, action, extra in [
            ("supervisor", "case.resolve", {"outcome": "DISMISSED"}),
            ("auditor", "audit.agree", {"resolution": {"outcome": "DISMISSED"}}),
            ("stabilizer", "contest.decide", {"outcome": "MODIFY_SCOPE", "scope": {"tasks": [], "obligations": []}}),
        ]:
            with self.subTest(action=action):
                engine = f.engine.with_actor(Actor(role, "seat:" + role))
                refuses(self, "STALE_REVIEW_INPUT", lambda: engine.mutate(action, dict(case=case["id"],
                        source_blob=f.blob, review_basis=basis, **extra), "stale-" + action))
        self.assertEqual("PENDING_SCREEN", f.engine.object("barrier", case["id"])["phase"])

    def test_auditor_agreement_is_bound_to_the_same_repair_inputs(self):
        f = self.f
        case = f.issue()
        f.call("supervisor", "issue.screen", case=case["id"], outcome="ESTABLISHED", source_blob=f.blob)
        resolution = dict(case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        f.call("auditor", "audit.agree", case=case["id"], source_blob=f.blob, resolution=resolution)
        self.revised_task(f.engine.store.blobs.put(b"Changed basis after auditor agreement"))
        f.call("supervisor", "review.rebase", case=case["id"])
        result = f.call("supervisor", "case.resolve", **resolution)
        self.assertIn("contest", result)
        self.assertEqual("CONTEST_PENDING", f.engine.object("barrier", case["id"])["phase"])

    def test_principal_latch_release_is_an_explicit_current_snapshot(self):
        f = self.f
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="wave-1", items=[])["bundle"]
        f.call("calibrator", "calibration.record", bundle=bundle["id"], wave=1, outcome="DRIFT", source_blob=f.blob)
        latch = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "latch")
        data = dict(latch=latch["id"], source_blob=f.blob)
        old = dict(data, **f.engine.handle({"action": "review.snapshot", "data": data}))
        f.call("pm", "case.contest", case=latch["case"])
        principal = f.engine.with_actor(Actor("principal", "seat:principal"))
        refuses(self, "STALE_REVIEW_INPUT", lambda: principal.mutate("latch.release", old, "old-latch-release"))
        self.assertTrue(f.engine.object("latch", latch["id"])["active"])
        f.call("principal", "latch.release", **data)
        self.assertFalse(f.engine.object("latch", latch["id"])["active"])

    def test_supported_adapter_public_snapshot_read_rebase_and_commit(self):
        f = self.f
        case = f.issue(role="constructor")
        counter = 0
        def invoke(action, data, expected=0):
            nonlocal counter
            counter += 1
            path = f.root / "审查 request.json"
            path.write_text(json.dumps({"action": action, "data": data, "request_id": "adapter-" + str(counter)}), encoding="utf-8")
            env = dict(os.environ, PYTHONPATH=str(ROOT / "skills/mission-pipeline/scripts"))
            result = subprocess.run([sys.executable, "-m", "mp_runtime.field_adapter", "--root", str(f.root),
                    "--actor", "supervisor", "--request-file", str(path)], cwd=ROOT.parent, env=env, capture_output=True, timeout=30)
            self.assertEqual(expected, result.returncode, (result.stdout, result.stderr))
            return json.loads(result.stdout)
        data = dict(case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        old = invoke("review.snapshot", {"case": case["id"]})["review_basis"]
        self.revised_task(f.engine.store.blobs.put(b"Adapter explicitly rereads this revised task"))
        self.assertEqual("STALE_REVIEW_INPUT", invoke("issue.screen", dict(data, review_basis=old), 3)["code"])
        basis = invoke("review.snapshot", {"case": case["id"]})["review_basis"]
        for sha in basis["blobs"]:
            read = subprocess.run([sys.executable, str(ROOT / "skills/mission-pipeline/scripts/mp"), "--root", str(f.root),
                                   "blob", "get", sha], capture_output=True, timeout=30)
            self.assertEqual(0, read.returncode)
            self.assertEqual(f.engine.store.blobs.get(sha), base64.b64decode(json.loads(read.stdout)["base64"]))
        invoke("review.rebase", {"case": case["id"], "review_basis": basis})
        basis = invoke("review.snapshot", {"case": case["id"]})["review_basis"]
        result = invoke("issue.screen", dict(data, review_basis=basis))
        self.assertEqual("DISMISSED", result["case"]["status"])
        self.assertTrue(result["committed"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
