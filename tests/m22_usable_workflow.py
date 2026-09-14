"""2.1 gate — the runtime a live deployment can actually finish a mission on.

One test per repaired defect of the 2.1 design record (S1-S14): honest execution
labels, no deadlock in rebase, per-case budgets, review deadlines that survive a
slow subagent, contestable dismissals, authorized cancellation, blanket decisions
that do not reach backwards, product digests that cover every reviewed write path,
closed outcome sets and the local seal conveniences.
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from v4_support import ROOT, Fixture, refuses
from mp_runtime.process import RuntimeRefusal, json_bytes
from mp_runtime.storage import digest

MP = ROOT / "skills/mission-pipeline/scripts/mp"
TABLE = ("| # | criterion | status | anchor | type |\n|---|---|---|---|---|\n"
         "| o | actual usable report | met | controlled output | R |\n")


class UsableRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)

    # ---------- helpers ----------

    def mp(self, args, role="pm", expect=0, env=None):
        result = subprocess.run([sys.executable, str(MP), "--root", str(self.f.root)] +
                                (["--actor", role] if role else []) + args,
                                capture_output=True, cwd=ROOT.parent, timeout=60,
                                env=dict(os.environ, **(env or {})))
        self.assertEqual(expect, result.returncode, (result.stdout, result.stderr))
        return json.loads(result.stdout)

    def seal(self, role, name, body, request, expect=0):
        path = self.f.root / name
        path.write_text(body + "\n```mp-json\n" + json.dumps(request) + "\n```\n", encoding="utf-8")
        return self.mp(["seal", str(path)], role=role, expect=expect)

    def raises(self, code, call):
        with self.assertRaises(RuntimeRefusal) as caught:
            call()
        self.assertEqual(code, caught.exception.code)
        return caught.exception

    def revise_task(self, blob, **changes):
        f = self.f
        task = f.engine.object("task", "t")
        f.call("pm", "task.record", **dict(task, revises=digest(task), inputs=[blob],
                                           source_blob=blob, **changes))

    def close_mission(self, target="close"):
        f = self.f
        bundle = f.call("pm", "bundle.record", mission="m", target=target, items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        return f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"],
                      review=review["id"], closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)

    # ---------- S1 / S2 ----------

    def test_s1_controller_identity_is_refused_at_every_public_entry(self):
        f = self.f
        f.setup()
        request = f.root / "probe-request.json"
        request.write_text(json.dumps({"action": "query", "data": {"kind": "task"}, "request_id": "probe"}), encoding="utf-8")
        for role, env in (("controller", None), (None, {"MP_ACTOR": "controller"})):
            with self.subTest(actor=role or "MP_ACTOR"):
                body = self.mp(["api", "--request-file", str(request)], role=role, expect=3, env=env)
                self.assertEqual("ROLE_FORBIDDEN", body["code"])
                self.assertIn("internal identity", body["detail"])
        adapter = subprocess.run([sys.executable, "-m", "mp_runtime.field_adapter", "--root", str(f.root),
                                  "--actor", "controller", "--request-file", str(request)],
                                 cwd=ROOT.parent, capture_output=True, timeout=60,
                                 env=dict(os.environ, PYTHONPATH=str(ROOT / "skills/mission-pipeline/scripts")))
        self.assertEqual(3, adapter.returncode, (adapter.stdout, adapter.stderr))
        self.assertEqual("ROLE_FORBIDDEN", json.loads(adapter.stdout)["code"])
        from mp_runtime import bridge
        message = {"root": str(f.root), "role": "controller", "request": {"action": "query", "data": {}, "request_id": "b"}}
        with patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(json_bytes(message)))):
            self.raises("ROLE_FORBIDDEN", bridge.serve_one)
        # A role seat still works through the same entry point.
        self.assertEqual(True, self.mp(["api", "--request-file", str(request)], role="pm")["ok"])

    def test_s1_only_a_product_seat_starts_a_verification_run(self):
        f = self.f
        f.setup()
        for role in ("pm", "researcher", "supervisor", "calibrator"):
            with self.subTest(role=role):
                refuses(self, "ROLE_FORBIDDEN", lambda: f.call(role, "run.execute", requirement="r", admission=f.admission))
        self.assertFalse(any(kind == "run" for kind, _ in f.engine.store.read()))
        self.assertTrue(f.call("constructor", "run.execute", requirement="r", admission=f.admission)["run"]["satisfied"])

    def test_s2_local_execution_is_labelled_honestly_and_a_fabricated_run_cannot_satisfy(self):
        f = self.f
        f.setup()
        f.accept()
        self.assertEqual("local-execution", f.run["assurance"])
        self.assertTrue(f.run["satisfied"])
        f.call("pm", "requirement.record", id="r2", task="t", argv=["{python}", "verify.py"],
               inputs=["verify.py"], environment="env")
        f.review_admit()
        manifest = f.engine.store.blobs.put(json_bytes([{"path": "verify.py",
                   "blob": hashlib.sha256((f.root / "verify.py").read_bytes()).hexdigest()}]))
        executable = f.engine.object("environment", "env")["executable"]
        environment = f.engine.store.blobs.put(json_bytes({"modules": {},
                      "runtime_sha256": hashlib.sha256(Path(executable).read_bytes()).hexdigest()}))
        log = f.engine.store.blobs.put(b"hand written claim\n")
        run = f.call("constructor", "run.begin", requirement="r2", admission=f.admission,
                     source_blob=f.blob, environment_blob=environment, input_blob=manifest)["run"]
        finished = f.call("constructor", "run.finish", run=run["id"], generation=run["generation"],
                          stdout_blob=log, stderr_blob=log, exit_code=0, result="pass")["run"]
        self.assertTrue(finished["satisfied"])
        self.assertEqual("posthoc-declared", finished["assurance"])
        refuses(self, "EXECUTION_ASSURANCE_REQUIRED", lambda: f.call("pm", "consume", admission=f.admission))

    # ---------- S3 ----------

    def test_s3_third_rebase_succeeds_the_case_and_the_mission_still_closes(self):
        f = self.f
        f.setup()
        case = f.issue(role="constructor")
        for index in range(2):
            self.revise_task(f.engine.store.blobs.put(("authorized revision " + str(index)).encode()))
            f.call("supervisor", "review.rebase", case=case["id"])
        self.revise_task(f.engine.store.blobs.put(b"third authorized revision"))
        result = f.call("supervisor", "review.rebase", case=case["id"])
        successor = result["case"]
        self.assertEqual(case["id"], result["superseded"])
        self.assertEqual(case["id"], successor["supersedes"])
        self.assertNotEqual(case["fact"], successor["fact"])
        self.assertEqual(case["scope"], successor["scope"])
        self.assertEqual(case["counterexample_blob"], successor["counterexample_blob"])
        self.assertEqual(case["author"], successor["author"])
        self.assertEqual("TARGET_REPLACED", f.engine.object("case", case["id"])["status"])
        self.assertEqual("RELEASED", f.engine.object("barrier", case["id"])["phase"])
        self.assertEqual("COMPLETE", f.engine.object("job", case["id"] + ":screen")["status"])
        self.assertEqual("PENDING_SCREEN", f.engine.object("barrier", successor["id"])["phase"])
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        # The successor is screened like any other case, and the mission can finish.
        f.call("supervisor", "issue.screen", case=successor["id"], outcome="DISMISSED", source_blob=f.blob)
        self.assertEqual("RELEASED", f.engine.object("barrier", successor["id"])["phase"])
        f.review_admit()
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        self.assertEqual("CLOSED", self.close_mission()["status"])

    def test_s3_a_pending_contest_on_the_replaced_case_is_superseded(self):
        f = self.f
        f.setup()
        case = f.issue(role="auditor")
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        self.assertEqual("PENDING", f.engine.object("contest", case["id"])["status"])
        for index in range(3):
            self.revise_task(f.engine.store.blobs.put(("contested revision " + str(index)).encode()))
            result = f.call("stabilizer", "review.rebase", case=case["id"])
        self.assertIn("superseded", result)
        self.assertEqual("SUPERSEDED", f.engine.object("contest", case["id"])["status"])
        self.assertEqual("COMPLETE", f.engine.object("job", case["id"] + ":contest")["status"])
        self.assertEqual("PENDING_SCREEN", f.engine.object("barrier", result["case"]["id"])["phase"])

    # ---------- S4 ----------

    def test_s4_correction_budget_is_per_case_so_a_thirteenth_case_still_works(self):
        f = self.f
        f.setup()
        cases = []
        for index in range(13):
            counterexample = f.engine.store.blobs.put(("counterexample number " + str(index)).encode())
            case = f.issue(role="constructor", counterexample_blob=counterexample)
            cases.append(case)
            f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
            self.assertEqual("RELEASED", f.engine.object("barrier", case["id"])["phase"])
        self.assertEqual(13, len({case["id"] for case in cases}))
        self.assertEqual(1, f.engine.object("budget", cases[-1]["id"] + ":correction")["count"])
        self.assertEqual(13, f.engine.object("budget", "m:correction_total")["count"])
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        self.assertEqual("CLOSED", self.close_mission()["status"])

    # ---------- S5 ----------

    def test_s5_deadline_is_configured_by_mode_and_validated(self):
        f = self.f
        self.assertEqual(86400, f.engine.object("config", "project")["review_deadline_seconds"])
        refuses(self, "INVALID_REVIEW_DEADLINE",
                lambda: f.call("principal", "project.configure", mode="local", review_deadline_seconds=30))
        refuses(self, "INVALID_REVIEW_DEADLINE",
                lambda: f.call("principal", "project.configure", mode="local", review_deadline_seconds="3600"))
        f.call("principal", "project.configure", mode="local", review_deadline_seconds=600)
        f.setup()
        case = f.issue(role="constructor")
        job = f.engine.object("job", case["id"] + ":screen")
        self.assertLess(abs(job["deadline"] - time.time() - 600), 30)

    def test_s5_a_late_screening_resumes_itself_and_then_expires_with_a_recovery(self):
        f = self.f
        f.setup()
        clock = [time.time()]
        case = f.issue(role="constructor")
        job_id = case["id"] + ":screen"
        with patch("mp_runtime.workflow.time.time", lambda: clock[0]):
            clock[0] = f.engine.object("job", job_id)["deadline"] + 1
            f.call("supervisor", "issue.screen", case=case["id"], outcome="ESTABLISHED", source_blob=f.blob)
            job = f.engine.object("job", job_id)
            self.assertTrue(job["auto_resumed"])
            self.assertEqual(1, job["resumes"])
            self.assertEqual(2, job["generation"])
            self.assertEqual("COMPLETE", job["status"])
        self.assertEqual("ESTABLISHED", f.engine.object("case", case["id"])["status"])

    def test_s5_an_exhausted_review_expires_honestly_and_the_recovery_works(self):
        f = self.f
        f.setup()
        clock = [time.time()]
        case = f.issue(role="constructor")
        job_id = case["id"] + ":screen"
        with patch("mp_runtime.workflow.time.time", lambda: clock[0]):
            for _ in range(2):  # No prior jobs.expire is needed for a merely late job.
                clock[0] = f.engine.object("job", job_id)["deadline"] + 1
                f.call("pm", "job.resume", job=job_id)
            self.assertEqual(2, f.engine.object("job", job_id)["resumes"])
            clock[0] = f.engine.object("job", job_id)["deadline"] + 1
            expired = self.raises("REVIEW_EXPIRED", lambda: f.call("supervisor", "issue.screen",
                                  case=case["id"], outcome="DISMISSED", source_blob=f.blob))
            self.assertEqual("case.contest or recovery.permit", expired.context["recovery"])
            self.assertEqual("REVIEW_EXPIRED", self.raises("REVIEW_EXPIRED",
                             lambda: f.call("pm", "job.resume", job=job_id)).code)
            # The named recovery is real: an independent contest still decides the case.
            f.call("pm", "case.contest", case=case["id"])
            f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
            self.assertEqual("RELEASED", f.engine.object("barrier", case["id"])["phase"])

    # ---------- S6 ----------

    def test_s6_resolution_cannot_pre_empt_a_contest_or_dismiss_an_unscreened_case(self):
        f = self.f
        f.setup()
        unscreened = f.issue(role="constructor")
        refuses(self, "SCREENING_REQUIRED", lambda: f.call("supervisor", "case.resolve",
                case=unscreened["id"], outcome="DISMISSED", source_blob=f.blob))
        self.assertEqual("PENDING_SCREEN", f.engine.object("barrier", unscreened["id"])["phase"])
        f.call("supervisor", "issue.screen", case=unscreened["id"], outcome="DISMISSED", source_blob=f.blob)
        audited = f.issue(role="auditor", counterexample_blob=f.engine.store.blobs.put(b"auditor counterexample"))
        f.call("supervisor", "issue.screen", case=audited["id"], outcome="DISMISSED", source_blob=f.blob)
        self.assertEqual("PENDING", f.engine.object("contest", audited["id"])["status"])
        refuses(self, "CONTEST_PENDING", lambda: f.call("supervisor", "case.resolve",
                case=audited["id"], outcome="DISMISSED", source_blob=f.blob))
        self.assertEqual("CONTEST_PENDING", f.engine.object("barrier", audited["id"])["phase"])

    def test_s6_any_reporter_role_can_contest_a_dismissal_once(self):
        f = self.f
        f.setup()
        case = f.issue(role="constructor")
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        self.assertEqual("RELEASED", f.engine.object("barrier", case["id"])["phase"])
        contest = f.call("crititor", "case.contest", case=case["id"])["contest"]
        self.assertEqual("PENDING", contest["status"])
        self.assertEqual("CONTEST_PENDING", f.engine.object("barrier", case["id"])["phase"])
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        self.assertTrue(f.call("calibrator", "case.contest", case=case["id"])["reused"])
        refuses(self, "ROLE_FORBIDDEN", lambda: f.call("principal", "case.contest", case=case["id"]))
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        self.assertEqual("RELEASED", f.engine.object("barrier", case["id"])["phase"])
        refuses(self, "CONTEST_FINAL", lambda: f.call("auditor", "case.contest", case=case["id"]))
        f.call("pm", "task.dispatch", admission=f.admission)

    def test_s6_the_challenger_supplies_the_one_bounded_supplement(self):
        f = self.f
        f.setup()
        case = f.issue(role="constructor")
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        f.call("challenger", "case.contest", case=case["id"])
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="INPUT_INCOMPLETE", source_blob=f.blob)
        self.assertEqual("INPUT_INCOMPLETE", f.engine.object("contest", case["id"])["status"])
        supplement = f.engine.store.blobs.put(b"The Challenger's actual defence of the accusation.")
        f.call("challenger", "case.supplement", case=case["id"], source_blob=supplement)
        self.assertEqual("PENDING", f.engine.object("contest", case["id"])["status"])
        self.assertEqual("CONTEST_PENDING", f.engine.object("barrier", case["id"])["phase"])
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        self.assertEqual("RELEASED", f.engine.object("barrier", case["id"])["phase"])

    # ---------- S7 ----------

    def test_s7_obligation_cancel_is_an_authorized_exit(self):
        f = self.f
        f.setup()
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        f.call("pm", "plan.record", id="gap-plan", mission="m", goals=["usable-report"], source_blob=f.blob,
               obligations=[dict(id="dropped", goal="usable-report", description="withdrawn optional format")])
        f.call("principal", "grant.record", id="no-defer", authority="a", source_blob=f.blob, scope="m",
               domains=["method"], permissions=["choose"])
        refuses(self, "AUTHORITY_CONFLICT", lambda: f.call("pm", "obligation.cancel", obligation="dropped",
                grant="no-defer", domain="method", owner="pm", reason_blob=f.blob))
        refuses(self, "DEFERRAL_INCOMPLETE", lambda: f.call("pm", "obligation.cancel", obligation="dropped",
                grant="g", domain="method"))
        refuses(self, "ROLE_FORBIDDEN", lambda: f.call("constructor", "obligation.cancel", obligation="dropped",
                grant="g", domain="method", owner="pm", reason_blob=f.blob))
        cancelled = f.call("pm", "obligation.cancel", obligation="dropped", grant="g", domain="method",
                           owner="pm", reason_blob=f.blob)["obligation"]
        self.assertEqual("AUTHORIZED_CANCELLED", cancelled["status"])
        self.assertEqual("pm", cancelled["cancelled_by"]["role"])
        self.assertEqual("pm", cancelled["deferred_owner"])
        self.assertFalse(cancelled["verified_fixed"])
        result = self.close_mission()
        self.assertEqual("CLOSED", result["status"])
        self.assertIn("AUTHORIZED_CANCELLED", [row["status"] for row in result["outcomes"]])

    # ---------- S8 ----------

    def test_s8_a_blanket_decision_does_not_reopen_accepted_work_but_a_named_one_does(self):
        f = self.f
        f.setup()
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        f.call("pm", "decision.record", id="later-blanket", mission="m", grant="g", domain="method",
               effects={"layout": "wide"}, rationale_blob=f.blob, choice="a later blanket method choice")
        self.assertTrue(f.call("pm", "consume", admission=f.admission)["committed"])
        f.call("pm", "decision.record", id="named", mission="m", grant="g", domain="method", tasks=["t"],
               effects={"layout": "narrow"}, rationale_blob=f.blob, choice="a choice about this very task")
        refuses(self, "STALE_DEPENDENCY", lambda: f.call("pm", "consume", admission=f.admission))

    # ---------- S9 ----------

    def test_s9_a_dead_run_lease_is_abortable_by_another_session(self):
        f = self.f
        f.setup()
        empty = f.engine.store.blobs.put(b"[]\n")
        log = f.engine.store.blobs.put(b"no result\n")
        args = dict(requirement="r", admission=f.admission, source_blob=empty,
                    input_blob=empty, environment_blob=empty)
        dead = f.call("constructor", "run.begin", deadline_seconds=0.05, **args)["run"]
        time.sleep(0.07)
        aborted = f.call("pm", "run.abort", run=dead["id"], stdout_blob=log, stderr_blob=log)["run"]
        self.assertEqual("EXPIRED", aborted["status"])
        self.assertEqual("RUN_LEASE_EXPIRED", aborted["failure_code"])
        self.assertFalse(aborted["satisfied"])
        self.assertEqual("pm", aborted["aborted_by"]["role"])
        live = f.call("constructor", "run.begin", deadline_seconds=3600, **args)["run"]
        late = f.call("pm", "run.abort", run=live["id"], generation=live["generation"],
                      code="EXECUTION_TIMEOUT", detail="not mine", stdout_blob=log, stderr_blob=log)
        self.assertIn("late_result", late)
        self.assertEqual("RUNNING", f.engine.object("run", live["id"])["status"])

    # ---------- S10 ----------

    def test_s10_a_write_path_outside_inputs_and_outputs_is_still_product(self):
        f = self.f
        f.setup()
        self.revise_task(f.blob, write_paths=["verify.py", "helper.py"])
        f.review_admit()
        helper = f.engine.store.blobs.put(b"# helper used by the product\n")
        f.call("constructor", "work.write", task="t", admission=f.admission, path="helper.py", source_blob=helper)
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        (f.root / "helper.py").write_text("# rewritten outside the pipeline\n", encoding="utf-8")
        refuses(self, "STALE_DEPENDENCY", lambda: f.call("pm", "consume", admission=f.admission))

    # ---------- S11 ----------

    def test_s11_a_completed_or_positive_report_needs_its_criteria_table(self):
        f = self.f
        f.setup()
        f.call("constructor", "run.execute", requirement="r", admission=f.admission)
        refuses(self, "CRITERIA_TABLE_REQUIRED", lambda: f.call("constructor", "report.record", kind="development",
                task="t", outcome="COMPLETE", source_blob=f.blob, criteria={"o": "met"}))
        stated = f.engine.store.blobs.put(b"# Implementation\n" + TABLE.encode())
        f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE",
               source_blob=stated, criteria={"o": "met"})
        refuses(self, "CRITERIA_TABLE_REQUIRED", lambda: f.call("crititor", "report.record", kind="critique",
                task="t", outcome="PASS", admission=f.admission, source_blob=f.blob, criteria={"o": "met"}))
        # A negative report never needs one; it is not claiming a met criterion.
        f.call("crititor", "report.record", kind="critique", task="t", outcome="CHANGES_REQUESTED",
               admission=f.admission, source_blob=f.blob)

    # ---------- S12 ----------

    def test_s12_audit_and_close_review_outcomes_are_closed_sets(self):
        f = self.f
        f.setup()
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        refuses(self, "INVALID_VERDICT", lambda: f.call("auditor", "audit.record", bundle=bundle["id"],
                source_blob=f.blob, findings=[], outcome="CLEAN"))
        refuses(self, "INVALID_VERDICT", lambda: f.call("auditor", "audit.record", bundle=bundle["id"],
                source_blob=f.blob, findings=[], outcome="FINDINGS"))
        refuses(self, "INVALID_VERDICT", lambda: f.call("supervisor", "close.review", bundle=bundle["id"],
                source_blob=f.blob, outcome="LOOKS_FINE"))
        derived = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        self.assertEqual("PASS", derived["outcome"])
        incomplete = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob,
                            findings=[], outcome="INPUT_INCOMPLETE")["audit"]
        self.assertEqual("INPUT_INCOMPLETE", incomplete["status"])
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        f.call("pm", "consume", admission=f.admission)
        refuses(self, "AUDIT_OUTCOME_REQUIRED", lambda: f.call("pm", "mission.close", mission="m",
                bundle=bundle["id"], audit=incomplete["id"], review=review["id"], closing_run=f.run["id"],
                grant="g", domain="method", source_blob=f.blob))
        result = f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=derived["id"],
                        review=review["id"], closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("CLOSED", result["status"])

    def test_s12_plan_review_outcomes_are_a_closed_set(self):
        f = self.f
        f.setup()
        refuses(self, "INVALID_VERDICT", lambda: f.call("supervisor", "plan.review", plan="p", tasks=["t"],
                outcome="LOOKS_GOOD", source_blob=f.blob))
        failed = f.call("supervisor", "plan.review", id="failed-review", plan="p", tasks=["t"],
                        outcome="FAIL", source_blob=f.blob)["review"]
        self.assertEqual("FAIL", failed["outcome"])
        refuses(self, "STALE_PLAN_REVIEW", lambda: f.call("pm", "task.admit", task="t", review=failed["id"]))

    def test_s12_plan_review_counts_a_settled_obligation_as_covered(self):
        f = self.f
        f.setup()
        f.call("pm", "plan.record", id="carry-plan", mission="m", goals=["usable-report"], source_blob=f.blob,
               obligations=[dict(id="carried", goal="usable-report", description="delivered before the upgrade")])
        refuses(self, "MISSING_PRODUCER", lambda: f.call("supervisor", "plan.review", id="carry-required",
                plan="carry-plan", tasks=[], outcome="PASS", source_blob=f.blob))
        f.call("pm", "obligation.cancel", obligation="carried", grant="g", domain="method",
               owner="pm", reason_blob=f.blob)
        cancelled = f.call("supervisor", "plan.review", id="carry-cancelled", plan="carry-plan",
                           tasks=[], outcome="PASS", source_blob=f.blob)["review"]
        self.assertEqual("PASS", cancelled["outcome"])
        # An obligation already MET - what legacy.accept records after a 1.2 upgrade - is covered too.
        f.accept()
        self.assertEqual("MET", f.engine.object("obligation", "o")["status"])
        f.call("pm", "plan.record", id="met-plan", mission="m", goals=["usable-report"], source_blob=f.blob,
               obligations=[dict(id="o", goal="usable-report", description="actual usable report")])
        met = f.call("supervisor", "plan.review", id="met-review", plan="met-plan", tasks=[],
                     outcome="PASS", source_blob=f.blob)["review"]
        self.assertEqual("PASS", met["outcome"])

    def test_s12_an_audit_with_a_finding_is_recorded_as_findings(self):
        f = self.f
        f.setup()
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        finding = dict(kind="MANDATORY_COUNTEREXAMPLE", source_blob=f.blob,
                       counterexample_blob=f.engine.store.blobs.put(b"the audit's own counterexample"),
                       target="t", tasks=["t"], obligations=["o"])
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[finding])["audit"]
        self.assertEqual("FINDINGS", audit["outcome"])
        self.assertEqual(1, len(audit["findings"]))

    def test_s12_flag_raise_needs_a_reporter_role_and_a_real_mission(self):
        f = self.f
        f.setup()
        refuses(self, "ROLE_FORBIDDEN", lambda: f.call("principal", "flag.raise", mission="m",
                text="a principal does not file product flags", source_blob=f.blob))
        refuses(self, "MISSING_REFERENCE", lambda: f.call("constructor", "flag.raise", mission="ghost",
                text="a flag against nothing", source_blob=f.blob))
        flag = f.call("crititor", "flag.raise", mission="m", text="actual noticed defect", source_blob=f.blob)["flag"]
        self.assertTrue(flag["live"])
        self.assertEqual("m", flag["mission"])

    # ---------- S13 ----------

    def test_s13_an_exported_run_output_cannot_be_redeclared_by_hand(self):
        f = self.f
        f.setup()
        f.accept()
        delivery = [row["data"] for (kind, _), row in f.engine.store.read().items()
                    if kind == "delivery" and row["data"]["current"]][-1]
        self.assertEqual(f.run["id"], delivery["run"])
        refuses(self, "EXPORTED_OUTPUT", lambda: f.call("constructor", "delivery.record", task="t",
                admission=f.admission, path="report.txt"))

    # ---------- S14 ----------

    def test_s14_seal_fills_the_reading_fields_and_keeps_an_explicit_source(self):
        f = self.f
        f.setup()
        f.call("constructor", "run.execute", requirement="r", admission=f.admission)
        first = self.seal("constructor", "dev-report.md", "# Development\n\n" + TABLE,
                          {"action": "report.record", "data": {"kind": "development", "task": "t",
                           "outcome": "COMPLETE", "criteria": {"o": "met"}}})
        self.assertTrue(first["committed"])
        document = f.engine.object("report", first["report"]["id"])["source_blob"]
        self.assertEqual(document, first["submitted_request"]["data"]["source_blob"])
        self.assertEqual(document, first["submitted_request"]["data"]["document_blob"])
        self.assertEqual(f.admission, first["submitted_request"]["data"]["admission"])
        self.assertNotIn("revises", first["submitted_request"]["data"])
        second = self.seal("constructor", "dev-report-2.md", "# Development, second round\n\n" + TABLE,
                           {"action": "report.record", "data": {"kind": "development", "task": "t", "round": 2,
                            "outcome": "COMPLETE", "criteria": {"o": "met"}}})
        self.assertEqual(first["report"]["id"], second["submitted_request"]["data"]["revises"])
        critique = self.seal("crititor", "critique.md", "# Independent critique\n\n" + TABLE,
                             {"action": "report.record", "data": {"kind": "critique", "task": "t", "round": 2,
                              "outcome": "PASS", "criteria": {"o": "met"}}})
        accepted = self.seal("stabilizer", "acceptance.md", "# Independent acceptance\n\n" + TABLE,
                             {"action": "report.record", "data": {"kind": "acceptance", "task": "t", "round": 2,
                              "outcome": "ACCEPTED", "criteria": {"o": "met"}}})
        self.assertEqual(critique["report"]["id"], accepted["submitted_request"]["data"]["critique"])
        self.assertEqual(critique["report"]["id"], accepted["report"]["critique"])
        self.assertEqual("MET", f.engine.object("obligation", "o")["status"])
        # An explicit source_blob in the block is never overwritten; the document is recorded beside it.
        flagged = self.seal("crititor", "flag.md", "# Noticed\n",
                            {"action": "flag.raise", "data": {"mission": "m", "text": "explicit source",
                             "source_blob": f.blob}})
        self.assertEqual(f.blob, flagged["flag"]["source_blob"])
        self.assertNotEqual(f.blob, flagged["submitted_request"]["data"]["document_blob"])

    def test_s14_seal_reads_review_inputs_and_ignores_unrelated_sections(self):
        f = self.f
        f.setup()
        body = "# Plan review\n\n## Single risk\n- None\n- an actual unrelated risk item\n"
        review = self.seal("supervisor", "plan-review.md", body,
                           {"action": "plan.review", "data": {"plan": "p", "tasks": ["t"], "outcome": "PASS"}})
        digest_now = f.engine.handle({"action": "contracts.snapshot", "data": {"mission": "m"}})["contract_scope_digest"]
        self.assertEqual(digest_now, review["submitted_request"]["data"]["contract_scope_digest"])
        self.assertEqual("self-asserted", review["submitted_request"]["data"]["reading_assurance"])
        self.assertEqual("PASS", review["review"]["outcome"])
        case = f.issue(role="constructor")
        screened = self.seal("supervisor", "screening.md", "# Screening\n\n## Noticed\n- None\n",
                             {"action": "issue.screen", "data": {"case": case["id"], "outcome": "DISMISSED"}})
        self.assertEqual("DISMISSED", screened["case"]["status"])
        self.assertEqual(review["submitted_request"]["data"]["reading_assurance"],
                         screened["submitted_request"]["data"]["reading_assurance"])
        self.assertIn("head", screened["submitted_request"]["data"]["review_basis"])
        # A report still has to keep its list sections honest.
        mixed = self.seal("constructor", "bad-report.md", "# Development\n\n" + TABLE + "\n## Single risk\n- None\n- and an actual risk\n",
                          {"action": "report.record", "data": {"kind": "development", "task": "t",
                           "outcome": "COMPLETE", "criteria": {"o": "met"}}}, expect=3)
        self.assertEqual("MIXED_NONE", mixed["code"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
