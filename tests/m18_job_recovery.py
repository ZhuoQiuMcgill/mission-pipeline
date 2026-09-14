"""R2: real driver termination, fresh CLI controller and bounded repair recovery."""
import base64
import hashlib
import json
import os
import subprocess
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from v4_support import ROOT, Fixture, refuses
from mp_runtime.engine import Engine
from mp_runtime.managed import ManagedBroker
from mp_runtime.storage import digest


class JobRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture(managed=True)
        self.addCleanup(self.f.close)
        self.f.broker = ManagedBroker(self.f.engine)
        self.f.broker.start()
        self.f.setup()
        self.case = self.f.issue()
        self.f.call("supervisor", "issue.screen", case=self.case["id"], outcome="DISMISSED", source_blob=self.f.blob)
        self.job = self.case["id"] + ":contest"
        self.driver = ROOT / "tests/fixtures/review_driver.py"

    def driver_argv(self, outcome, request_id, **data):
        return [sys.executable, str(self.driver), json.dumps(dict(case=self.case["id"], outcome=outcome, request_id=request_id, **data))]

    def cli_driver(self, outcome, request_id, repair=None, rebase=False):
        f = self.f
        config = f.root / (request_id + "-driver.json")
        data = dict(repair or {})
        if repair:
            data["counterexample_eliminated"] = True
        if rebase:
            data["rebase"] = True
        config.write_text(json.dumps({"parallel_host_tools": False, "argv": self.driver_argv(outcome, request_id, **data)}), encoding="utf-8")
        argv = [sys.executable, str(ROOT / "skills/mission-pipeline/scripts/mp"), "--root", str(f.root),
                "managed", "run", "--job", self.job, "--driver-config", str(config)]
        if repair:
            path = f.root / (request_id + "-repair.json")
            path.write_text(json.dumps(repair), encoding="utf-8")
            argv += ["--repair-file", str(path)]
        result = subprocess.run(argv, capture_output=True, cwd=ROOT.parent, timeout=60)
        self.assertEqual(0, result.returncode, (result.stdout, result.stderr))
        body = json.loads(result.stdout)
        decision = json.loads(body["final_document"])
        self.assertTrue(decision["ok"], decision)
        print("R2_PUBLIC_DRIVER_RECEIPT " + json.dumps({"argv": argv, "returncode": result.returncode,
              "session": body["session"], "decision": decision}, sort_keys=True), flush=True)
        return body, decision["result"]

    def repair(self, revise=False):
        f = self.f
        permit = f.call("pm", "recovery.permit", case=self.case["id"], tasks=["t"])["permit"]
        if revise:
            task = f.engine.object("task", "t")
            source = f.broker.tool(f.seats["pm"], {"tool": "submit_blob", "base64": base64.b64encode(b"PM authorized repair method revision").decode()})["blob"]
            f.call("pm", "task.record", **dict(task, revises=digest(task), source_blob=source, inputs=[source]))
        f.review_admit(permit["id"])
        old = (f.root / "verify.py").read_bytes()
        raw = old + b"\nprint('independently verified repair revision')\n"
        seat = f.seats["constructor"] if "constructor" in f.seats else f.broker.seat("constructor", "m")
        sha = f.broker.tool(seat, {"tool": "submit_blob", "base64": base64.b64encode(raw).decode()})["blob"]
        f.seats["constructor"] = seat
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py",
               expected_sha256=hashlib.sha256(old).hexdigest(), source_blob=sha)
        f.accept()
        self.assertTrue(f.run["satisfied"])
        self.assertTrue((f.root / "report.txt").read_text().startswith("A usable report"))

    def close_mission(self):
        f = self.f
        f.review_admit()
        self.assertEqual("t", f.call("pm", "consume", task="t", admission=f.admission)["consumption"]["task"])
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        result = f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"], review=review["id"],
                        closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("CLOSED", result["status"])

    def test_public_fresh_controller_after_uphold_repair_verified_consume_close(self):
        f = self.f
        first, _ = self.cli_driver("UPHOLD", "merits-uphold")
        job = f.engine.object("job", self.job)
        self.assertEqual("AWAIT_REPAIR", job["status"])
        self.assertFalse(job["occupied"])
        self.assertEqual(0, job.get("failures", 0))
        fresh = ManagedBroker(Engine(f.root))
        self.assertEqual({}, fresh.sessions)
        with self.assertRaises(Exception):
            fresh.job_seat(self.job, {"repair_tasks": ["t"]})
        self.assertEqual("ESTABLISHED_HOLD", f.engine.object("barrier", self.case["id"])["phase"])
        self.repair(revise=True)
        second, result = self.cli_driver("REPAIR_VERIFIED", "repair-verified", {"repair_tasks": ["t"]}, rebase=True)
        self.assertNotEqual(first["session"], second["session"])
        job = f.engine.object("job", self.job)
        contest = f.engine.object("contest", self.case["id"])
        self.assertEqual(2, job["generation"])
        self.assertEqual(0, job.get("failures", 0))
        self.assertEqual(1, contest["repair_checks"])
        self.assertEqual(first["session"], contest["reviewer"])
        self.assertEqual(self.case["target_digest"], f.engine.object("case", self.case["id"])["target_digest"])
        self.assertEqual(1, len(f.engine.object("case", self.case["id"])["review_rebases"]))
        self.assertEqual(["UPHOLD", "REPAIR_VERIFIED"], [x["outcome"] for x in contest["decisions"]])
        self.assertFalse(result["supervisor_signature_required"])
        self.assertEqual(3, f.engine.object("budget", self.case["id"] + ":correction")["count"])
        self.assertEqual(3, f.engine.object("budget", self.case["lineage"] + ":correction_total")["count"])
        refuses(self, "STALE_REVIEW", lambda: fresh.job_seat(self.job, {"repair_tasks": ["t"]}))
        self.close_mission()

    def test_reconstructed_controllers_unique_claim_and_old_generation_refused(self):
        f = self.f
        old_broker = f.broker
        old_seat = old_broker.job_seat(self.job)
        outcome = old_broker.run_driver(old_seat, self.driver_argv("UPHOLD", "uphold"))
        self.assertTrue(json.loads(outcome["final_document"])["ok"])
        refuses(self, "STALE_SESSION", lambda: old_broker.tool(old_seat, {"tool": "refresh_packet"}))
        self.repair()
        barrier = threading.Barrier(2)
        def claim():
            broker = ManagedBroker(Engine(f.root))
            barrier.wait()
            try:
                return broker, broker.job_seat(self.job, {"repair_tasks": ["t"]})
            except Exception as exc:
                return None, getattr(exc, "code", str(exc))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: claim(), range(2)))
        winners = [(b, s) for b, s in results if b]
        self.assertEqual(1, len(winners), results)
        self.assertEqual(["JOB_OCCUPIED"], [s for b, s in results if not b])
        broker, seat = winners[0]
        refuses(self, "STALE_SESSION", lambda: broker.engine.mutate("job.transport_finished", {
            "job": self.job, "instance": old_seat["id"], "generation": old_seat["generation"]}, "old-retirement"))
        packet = broker.packet(seat)
        for blob in packet["input_manifest"]:
            broker.tool(seat, {"tool": "read_blob", "blob": blob})
        request = {"request_id": "stale-repair", "action": "contest.decide", "data": {
            "case": self.case["id"], "outcome": "REPAIR_VERIFIED", "repair_tasks": ["t"],
            "counterexample_eliminated": True, "source_blob": f.blob}}
        f.call("principal", "grant.revoke", grant="g", source_blob=f.blob)
        refuses(self, "STALE_REVIEW_INPUT", lambda: broker.tool(seat, {"tool": "submit", "request": request}))
        self.assertEqual("ESTABLISHED_HOLD", f.engine.object("barrier", self.case["id"])["phase"])
        self.assertEqual(0, f.engine.object("contest", self.case["id"])["repair_checks"])

    def test_failed_transport_retry_is_finite_and_does_not_replace_the_merits_case(self):
        f = self.f
        for attempt in range(2):
            broker = ManagedBroker(Engine(f.root))
            seat = broker.job_seat(self.job)
            # A normal transport exit without a decision is incomplete, never a release.
            broker.run_driver(seat, [sys.executable, "-c", "import json,sys;json.loads(sys.stdin.readline());print(json.dumps({'final_document':'no judgment'}),flush=True)"])
            job = f.engine.object("job", self.job)
            self.assertEqual("UNAVAILABLE", job["status"])
            self.assertEqual(attempt + 1, job["failures"])
            self.assertFalse(job["occupied"])
            if attempt == 0:
                f.call("pm", "job.resume", job=self.job)
        refuses(self, "BUDGET_EXHAUSTED", lambda: f.call("pm", "job.resume", job=self.job))
        self.assertEqual(0, f.engine.object("contest", self.case["id"])["repair_checks"])
        self.assertEqual(1, len([k for k, _ in f.engine.store.read() if k == "contest"]))

    def test_failed_process_start_releases_occupancy_for_the_one_actual_retry(self):
        f = self.f
        broker = ManagedBroker(Engine(f.root))
        seat = broker.job_seat(self.job)
        with self.assertRaises(FileNotFoundError):
            broker.run_driver(seat, [str(f.root / "missing-driver")])
        self.assertFalse(f.engine.object("job", self.job)["occupied"])
        self.assertEqual(1, f.engine.object("job", self.job)["failures"])
        f.call("pm", "job.resume", job=self.job)
        self.cli_driver("UPHOLD", "retry-merits")
        self.assertEqual("AWAIT_REPAIR", f.engine.object("job", self.job)["status"])
        self.assertEqual(1, f.engine.object("job", self.job)["failures"])


if __name__ == "__main__":
    if os.name == "nt":
        root = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:]
        raise SystemExit(subprocess.run(["wsl", "--distribution", "Ubuntu", "--cd", root, "--exec", "/usr/bin/python3", "tests/m18_job_recovery.py"]).returncode)
    unittest.main(verbosity=2)
