"""R4 principal scope compilation and current required-attempt qualification."""
import base64
import hashlib
import json
import os
import subprocess
import sys
import unittest
from v4_support import ROOT, Fixture, refuses
from mp_runtime.managed import ManagedBroker
from mp_runtime.workflow import Actor
from mp_runtime.process import RuntimeRefusal
import m19_contract_scope as contract_tests
import m20_current_calibration as calibration_tests


class ContractCompilationTests(unittest.TestCase):
    setUp = contract_tests.ContractTests.setUp
    a_call = contract_tests.ContractTests.a_call
    choose = contract_tests.ContractTests.choose
    def test_project_scope_cannot_be_narrowed_by_duplicates_order_or_omission(self):
        f = self.f
        f.setup(constraints={})
        self.a_blob = f.engine.store.blobs.put(b"Principal: all project reports across every mission must remain private.")
        self.a_call("principal", "authority.record", id="aA", source_blob=self.a_blob, goals=["reportA"],
                    constraints={"privacy": "private"}, constraint_scopes={"privacy": "project"})
        self.a_call("pm", "intake.create", id="iA", authority="aA", mission="A")
        narrow = dict(authority="aA", clause="privacy", scope="A")
        wide = dict(authority="aA", clause="privacy", scope="project")
        previous = None
        for items in ([narrow], [narrow, wide], [wide, narrow], [narrow, narrow]):
            c = self.a_call("pm", "root.propose", intake="iA", revises=previous, source_blob=self.a_blob,
                            goals=["reportA"], contracts=items)["candidate"]
            previous = c["id"]
            refuses(self, "CONTRACT_AUTHORITY_REQUIRED", lambda: self.a_call("supervisor", "root.review",
                    candidate=c["id"], outcome="MATCH", source_blob=self.a_blob))
            self.assertNotIn(("root", "A"), f.engine.store.read())
            self.assertFalse(any(k == "contract" for k, _ in f.engine.store.read()))
        # Correcting the draft under the original principal source needs no new authority.
        c = self.a_call("pm", "root.propose", intake="iA", revises=previous, source_blob=self.a_blob,
                        goals=["reportA"], contracts=[wide, wide])["candidate"]
        r = self.a_call("supervisor", "root.review", candidate=c["id"], outcome="MATCH", source_blob=self.a_blob)["review"]
        self.a_call("pm", "root.activate", candidate=c["id"], review=r["id"])
        contracts = [v["data"] for (k, _), v in f.engine.store.read().items() if k == "contract"]
        self.assertEqual(["project"], [x["scope"] for x in contracts])
        refuses(self, "AUTHORITY_CONFLICT", lambda: self.choose("public", "wrong-public"))
        self.choose("private", "right-private")
        f.review_admit()
        f.accept()
        self.assertTrue(f.call("pm", "consume", admission=f.admission)["committed"])


class AttemptTests(unittest.TestCase):
    def fixture(self, managed=True):
        f = Fixture()
        self.addCleanup(f.close)
        if managed:
            f.broker = ManagedBroker(f.engine)
            f.broker.start()
        f.setup()
        return f

    def write(self, f, raw):
        before = (f.root / "verify.py").read_bytes()
        if getattr(f, "broker", None):
            if "constructor" not in f.seats:
                f.seats["constructor"] = f.broker.seat("constructor", "m")
            f.broker.packet(f.seats["constructor"])
            blob = f.broker.tool(f.seats["constructor"], {"tool": "submit_blob", "base64": base64.b64encode(raw).decode()})["blob"]
        else:
            blob = f.engine.store.blobs.put(raw)
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py", source_blob=blob,
               expected_sha256=hashlib.sha256(before).hexdigest())

    def request(self, f, role, request):
        seat = f.seats.get(role) or f.broker.seat(role, "m")
        f.seats[role] = seat
        packet = f.broker.packet(seat)
        for blob in packet["input_manifest"]:
            f.broker.tool(seat, {"tool": "read_blob", "blob": blob})
        return f.broker.tool(seat, {"tool": "submit", "request": request})

    def test_real_timeout_cannot_borrow_old_pass_and_same_request_recovers_without_execution(self):
        f = self.fixture()
        self.write(f, (f.root / "verify.py").read_bytes() + b"\nimport time\ntime.sleep(0.5)\n")
        f.accept()
        initial = f.run
        self.assertFalse(f.engine.object("task", "t")["calibration_required"])
        f.call("pm", "consume", admission=f.admission)
        prior = {v["data"]["kind"]: v["data"] for (k, _), v in f.engine.store.read().items() if k == "report"}
        req = dict(action="run.execute", request_id="r4-timeout", data=dict(requirement="r", admission=f.admission,
                   purpose="independent_check", reason="Repeat this required verification", timeout=0.05))
        refuses(self, "EXECUTION_TIMEOUT", lambda: self.request(f, "crititor", req))
        timeout = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "run" and v["data"]["id"] != initial["id"])
        self.assertEqual("TIMED_OUT", timeout["status"])
        self.assertFalse(timeout["satisfied"])
        self.assertEqual(initial["key"], timeout["key"])
        f.engine.store.rebuild()
        refuses(self, "EXECUTION_TIMEOUT", lambda: self.request(f, "crititor", req))
        self.assertEqual(2, len([k for k, _ in f.engine.store.read() if k == "run"]))
        refuses(self, "REQUIRED_VERIFICATION_UNSATISFIED", lambda: f.call("pm", "consume", admission=f.admission))
        refuses(self, "BUDGET_EXHAUSTED", lambda: f.call("constructor", "run.execute", requirement="r", admission=f.admission))
        f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=prior["development"]["source_blob"],
               round=2, revises=prior["development"]["id"], criteria={"o": "met"})
        for role, kind, outcome in (("crititor", "critique", "PASS"), ("stabilizer", "acceptance", "ACCEPTED")):
            refuses(self, "REQUIRED_VERIFICATION_UNSATISFIED", lambda: f.call(role, "report.record", kind=kind, task="t",
                    outcome=outcome, admission=f.admission, round=2, revises=prior[kind]["id"], source_blob=prior[kind]["source_blob"],
                    criteria={"o": "met"}, critique=prior["critique"]["id"]))
        recovered = f.call("crititor", "run.execute", requirement="r", admission=f.admission, purpose="independent_check",
                           reason="Finish the interrupted required check", timeout=10)["run"]
        self.assertTrue(recovered["satisfied"])
        self.assertEqual(initial["key"], recovered["key"])
        self.assertEqual(3, recovered["generation"])
        # Old generation cannot overwrite the successful recovery.
        executor = f.engine.with_actor(Actor("controller", timeout["owner_session"], True))
        late = executor.mutate("run.finish", dict(run=timeout["id"], generation=timeout["generation"], stdout_blob=f.blob,
                               stderr_blob=f.blob, result="pass", exit_code=0), "r4-late-finish")
        self.assertFalse(late["late_result"]["satisfied"])
        f.accept(round=3)
        self.assertEqual(recovered["id"], f.run["id"])
        self.assertTrue(f.call("pm", "consume", admission=f.admission)["committed"])
        closed = calibration_tests.CalibrationTests.close_mission(type("Holder", (), {"f": f, "assertEqual": self.assertEqual})())
        budget = f.engine.object("budget", "t:independent_run")
        self.assertEqual(2, budget["count"])
        print("R4_TIMEOUT_RECOVERY " + json.dumps(dict(initial=initial["id"], timeout=timeout, recovered=recovered["id"], close=closed, budget=budget)))

    def test_real_start_and_post_execution_errors_are_terminal_and_retry_is_bounded(self):
        for post in (False, True):
            with self.subTest(post_execution=post):
                f = self.fixture(managed=False)
                if post:
                    self.write(f, (f.root / "verify.py").read_bytes() + b"\nfrom pathlib import Path\nPath(__file__).write_text('changed input')\n")
                    code = "SOURCE_CHANGED_DURING_RUN"
                    requirement = "r"
                else:
                    f.call("pm", "requirement.record", id="bad-start", task="t", argv=[str(f.root / "absent-executable")],
                           inputs=["verify.py"], environment="env")
                    f.review_admit()
                    code, requirement = "EXECUTION_ERROR", "bad-start"
                engine = f.engine.with_actor(Actor("constructor", "stable-runner"))
                request = dict(action="run.execute", request_id="r4-error", data=dict(requirement=requirement, admission=f.admission))
                refuses(self, code, lambda: engine.handle(request))
                failed = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "run")
                self.assertEqual("EXECUTION_FAILED", failed["status"])
                f.engine.store.rebuild()
                refuses(self, code, lambda: engine.handle(request))
                self.assertEqual(1, len([k for k, _ in f.engine.store.read() if k == "run"]))
                if not post:
                    for index, purpose in enumerate((None, "independent_check")):
                        retry = dict(action="run.execute", request_id="retry-" + str(index), data=dict(request["data"], purpose=purpose, reason="Repair startup"))
                        refuses(self, code, lambda: engine.handle(retry))
                    self.assertEqual(2, f.engine.object("budget", "t:run_recovery")["count"])
                    f.call("pm", "requirement.record", id="renamed-start", task="t", argv=[str(f.root / "absent-executable")],
                           inputs=["verify.py"], environment="env")
                    f.review_admit()
                    refuses(self, "BUDGET_EXHAUSTED", lambda: f.call("constructor", "run.execute", requirement="renamed-start", admission=f.admission))

    def test_nonrequired_failure_and_expected_negative_do_not_replace_required_pass(self):
        f = self.fixture()
        f.call("pm", "requirement.record", id="diagnostic", task="t", argv=["{python}", "-c", "raise SystemExit(2)"],
               inputs=[], environment="env", required=False)
        f.call("pm", "requirement.record", id="expected", task="t", argv=["{python}", "-c", "print('expected');raise SystemExit(7)"],
               inputs=[], environment="env", predicate={"kind": "expected_negative", "exit_code": 7, "diagnostic": "expected"})
        f.review_admit()
        f.call("constructor", "run.execute", requirement="expected", admission=f.admission)
        f.accept()
        old = f.run["id"]
        failed = f.call("crititor", "run.execute", requirement="diagnostic", admission=f.admission)["run"]
        self.assertFalse(failed["satisfied"])
        self.assertTrue(f.call("pm", "consume", admission=f.admission)["committed"])
        self.assertEqual(old, f.call("constructor", "run.execute", requirement="r", admission=f.admission)["run"]["id"])


if __name__ == "__main__":
    if os.name == "nt":
        local = unittest.TestSuite([AttemptTests("test_real_start_and_post_execution_errors_are_terminal_and_retry_is_bounded")])
        if not unittest.TextTestRunner(verbosity=2).run(local).wasSuccessful():
            raise SystemExit(1)
        root = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:]
        raise SystemExit(subprocess.run(["wsl", "-d", "Ubuntu", "--cd", root, "--exec", "/usr/bin/python3", "tests/m21_attempts_and_contracts.py"]).returncode)
    unittest.main(verbosity=2)
