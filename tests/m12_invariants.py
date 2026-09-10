import hashlib
import json
import time
import unittest
from unittest.mock import patch
from v4_support import Fixture, refuses, ROOT
from mp_runtime.markdown import document_fields, criteria_rows
from mp_runtime.storage import digest
from mp_runtime.workflow import Actor


class InvariantTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)

    def test_complete_markdown_and_conflicting_rows(self):
        raw = b"## Single risk\n- first line\n  continuation\n  - nested detail\n  ```text\n  ## literal header\n  ```\n## Engine relay\n- full relay\n  another line\n"
        parsed = document_fields(raw)
        self.assertIn("continuation", parsed["lists"]["Single risk"][0]["text"])
        self.assertIn("## literal header", parsed["lists"]["Single risk"][0]["text"])
        self.assertIn("another line", parsed["lists"]["Engine relay"][0]["text"])
        refuses(self, "MIXED_NONE", lambda: document_fields(b"## Single risk\n- None\n- actual risk\n"))
        refuses(self, "MULTIPLE_SINGLE_ITEMS", lambda: document_fields(b"## Single risk\n- first\n- second\n"))
        table = b"| # | criterion | status | anchor | type |\n|---|---|---|---|---|\n| 4 | all tables | met | run:1 | R |\n| 4 | all tables | partial | run:2 | R |\n"
        refuses(self, "CONFLICTING_CRITERION", lambda: criteria_rows(table))
        self.assertEqual("partial", criteria_rows(table, True)["criteria"]["4"]["met"])

    def test_root_mistranslation_never_activates_contract(self):
        f = self.f
        b = f.blob
        f.call("principal", "authority.record", id="a", source_blob=b, goals=["required"], constraints={})
        f.call("pm", "intake.create", id="i", authority="a", mission="m")
        f.call("pm", "root.propose", id="c1", intake="i", source_blob=b, goals=["different"], contracts=[{"clause": "invented"}])
        refuses(self, "GOAL_COVERAGE_GAP", lambda: f.call("supervisor", "root.review", candidate="c1", outcome="MATCH", source_blob=b))
        self.assertNotIn(("root", "m"), f.engine.store.read())
        self.assertFalse(any(k == "contract" for k, _ in f.engine.store.read()))
        f.call("pm", "root.propose", id="c2", intake="i", source_blob=b, goals=["required"], revises="c1")
        refuses(self, "STALE_DEPENDENCY", lambda: f.call("supervisor", "root.review", candidate="c1", outcome="MATCH", source_blob=b))
        review = f.call("supervisor", "root.review", candidate="c2", outcome="MATCH", source_blob=b)["review"]
        f.call("pm", "root.activate", candidate="c2", review=review["id"])

    def test_authorized_choices_reserved_boundary_and_flag_lifecycle(self):
        f = self.f
        f.setup()
        f.call("pm", "decision.record", mission="m", grant="g", domain="method", choice="change dedup policy from 3 to 2", effects={"dedup_count": 2}, rationale_blob=f.blob, revises="d")
        refuses(self, "AUTHORITY_CONFLICT", lambda: f.call("pm", "decision.record", mission="m", grant="g", domain="method", choice="publish private data", effects={"privacy": "public"}, rationale_blob=f.blob))
        flag = f.call("constructor", "flag.raise", mission="m", text="report label", source_blob=f.blob)["flag"]
        f.call("pm", "flag.change", flag=flag["id"], grant="g", domain="method", operation="retire", reason_blob=f.blob)
        self.assertFalse(f.engine.object("flag", flag["id"])["live"])
        f.call("pm", "flag.change", flag=flag["id"], grant="g", domain="method", operation="reopen", reason_blob=f.blob)
        self.assertTrue(f.engine.object("flag", flag["id"])["live"])
        other = f.call("constructor", "flag.raise", mission="m", text="better precise label", source_blob=f.blob)["flag"]
        f.call("pm", "flag.change", flag=flag["id"], grant="g", domain="method", operation="replace", replacement=other["id"], reason_blob=f.blob)
        self.assertEqual(other["id"], f.engine.object("flag", flag["id"])["superseded_by"])

    def test_contract_scope_requires_principal_authority_and_atomic_activation(self):
        f = self.f
        for number, scopes in enumerate(({}, {"privacy": "project"})):
            authority, intake, mission = "a" + str(number), "i" + str(number), "m" + str(number)
            f.call("principal", "authority.record", id=authority, source_blob=f.blob, goals=["report"], constraints={"privacy": "private"}, constraint_scopes=scopes)
            f.call("pm", "intake.create", id=intake, authority=authority, mission=mission)
            candidate = f.call("pm", "root.propose", intake=intake, source_blob=f.blob, goals=["report"], contracts=[{"authority": authority, "clause": "privacy", "scope": "project"}])["candidate"]
            if not scopes:
                refuses(self, "CONTRACT_AUTHORITY_REQUIRED", lambda: f.call("supervisor", "root.review", candidate=candidate["id"], outcome="MATCH", source_blob=f.blob))
                self.assertNotIn(("root", mission), f.engine.store.read())
                self.assertFalse(any(k == "contract" for k, _ in f.engine.store.read()))
                candidate = f.call("pm", "root.propose", intake=intake, revises=candidate["id"], source_blob=f.blob, goals=["report"], contracts=[{"authority": authority, "clause": "privacy", "scope": mission}])["candidate"]
            review = f.call("supervisor", "root.review", candidate=candidate["id"], outcome="MATCH", source_blob=f.blob)["review"]
            f.call("pm", "root.activate", candidate=candidate["id"], review=review["id"])
            contract = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "contract" and v["data"]["mission"] == mission)
            self.assertEqual("project" if scopes else mission, contract["scope"])

    def test_plan_requires_feasible_producer_and_recovers_with_authorized_task_revision(self):
        f = self.f
        f.setup()
        plan = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "plan")
        refuses(self, "MISSING_PRODUCER", lambda: f.call("supervisor", "plan.review", plan=plan["id"], tasks=[], outcome="PASS", source_blob=f.blob))
        task = f.engine.object("task", "t")
        f.call("pm", "task.record", **dict(task, revises=digest(task), effects=["produce-report"], allowed_effects=[]))
        refuses(self, "INFEASIBLE_TASK", lambda: f.call("supervisor", "plan.review", plan=plan["id"], tasks=["t"], outcome="PASS", source_blob=f.blob))
        task = f.engine.object("task", "t")
        f.call("pm", "task.record", **dict(task, revises=digest(task), allowed_effects=["produce-report"]))
        review = f.call("supervisor", "plan.review", plan=plan["id"], tasks=["t"], outcome="PASS", source_blob=f.blob)["review"]
        f.admission = f.call("pm", "task.admit", task="t", review=review["id"])["admission"]["id"]
        f.accept()
        f.call("pm", "consume", admission=f.admission)

    def test_no_positive_acceptance_without_pass_and_round_reset(self):
        f = self.f
        f.setup()
        refuses(self, "REQUIRED_VERIFICATION_UNSATISFIED", lambda: f.call("stabilizer", "report.record", kind="acceptance", task="t", outcome="ACCEPTED", admission=f.admission, source_blob=f.blob, criteria={"o": "met"}, critique="missing"))
        report = f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=f.blob, round=1)["report"]
        report2 = f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=f.blob, round=2, revises=report["id"])["report"]
        refuses(self, "STALE_HEAD", lambda: f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=f.blob, round=2, revises=report["id"]))
        refuses(self, "ROUND_SEQUENCE", lambda: f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=f.blob, round=1, revises=report2["id"]))
        refuses(self, "ROUND_CAP", lambda: f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=f.blob, round=4, revises=report2["id"]))

    def test_pending_generation_and_late_result(self):
        f = self.f
        f.setup()
        empty = f.engine.store.blobs.put(b"[]\n")
        args = dict(requirement="r", admission=f.admission, source_blob=empty, input_blob=empty, environment_blob=empty, deadline_seconds=0.03)
        run = f.call("constructor", "run.begin", **args)["run"]
        pending = f.call("crititor", "run.begin", **args)
        self.assertTrue(pending["pending"])
        time.sleep(0.04)
        log = f.engine.store.blobs.put(b"pass")
        late = f.call("constructor", "run.finish", run=run["id"], generation=run["generation"], stdout_blob=log, stderr_blob=log, exit_code=0, result="pass")
        self.assertFalse(late["late_result"]["satisfied"])
        recovered = f.call("constructor", "run.execute", requirement="r", admission=f.admission)["run"]
        self.assertTrue(recovered["satisfied"])

    def test_calibration_latch_scopes_and_false_drift_contest(self):
        f = self.f
        f.setup()
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="wave-1", items=[])["bundle"]
        f.call("calibrator", "calibration.record", bundle=bundle["id"], wave=1, outcome="DRIFT", source_blob=f.blob)
        f.call("calibrator", "calibration.record", bundle=bundle["id"], wave=1, outcome="ALIGNED", source_blob=f.blob)
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "consume", admission=f.admission))
        latch = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "latch")
        self.assertTrue(latch["active"])
        f.call("pm", "case.contest", case=latch["case"])
        f.call("stabilizer", "contest.decide", case=latch["case"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        self.assertFalse(f.engine.object("latch", latch["id"])["active"])
        f.call("pm", "consume", admission=f.admission)

    def test_same_round_annotation_preserves_reviews_and_substance_costs_round(self):
        f = self.f
        f.setup()
        f.accept()
        report = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "report" and v["data"]["kind"] == "development")
        result = f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=report["source_blob"],
                        criteria=report["criteria"], round=1, revises=report["id"], annotation_blob=f.blob)
        self.assertTrue(result["metadata_only"])
        f.call("pm", "consume", admission=f.admission)
        changed = f.engine.store.blobs.put(b"Substantially different product claims")
        refuses(self, "SUBSTANTIVE_REVISION_REQUIRES_ROUND", lambda: f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=changed, round=1, revises=report["id"]))

    def test_aggregate_pair_ignores_same_wave_and_task_alignment(self):
        f = self.f
        f.setup()
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="wave-1", items=[])["bundle"]
        for _ in range(2):
            f.call("calibrator", "calibration.record", bundle=bundle["id"], wave=1, outcome="SUSPICION", source_blob=f.blob)
        self.assertFalse(any(k == "latch" for k, _ in f.engine.store.read()))
        f.call("pm", "wave.integrate", mission="m", number=1, source_blob=f.blob)
        f.call("pm", "wave.open", mission="m", number=2)
        f.call("calibrator", "calibration.record", bundle=bundle["id"], task="t", wave=1, outcome="ALIGNED", source_blob=f.blob)
        f.call("calibrator", "calibration.record", bundle=bundle["id"], wave=2, outcome="SUSPICION", source_blob=f.blob)
        self.assertEqual(1, len([1 for k, _ in f.engine.store.read() if k == "latch"]))
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "consume", admission=f.admission))

    def test_expired_review_rejects_late_result_and_has_finite_resume(self):
        f = self.f
        f.setup()
        case = f.issue()
        job = f.engine.object("job", case["id"] + ":screen")
        with patch("mp_runtime.workflow.time.time", return_value=job["deadline"] + 1):
            f.call("controller", "jobs.expire")
            refuses(self, "STALE_REVIEW", lambda: f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob))
            f.call("pm", "job.resume", job=job["id"])
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        contest = f.engine.object("job", case["id"] + ":contest")
        with patch("mp_runtime.workflow.time.time", return_value=contest["deadline"] + 1):
            f.call("controller", "jobs.expire")
            refuses(self, "STALE_REVIEW", lambda: f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob))
            f.call("pm", "job.resume", job=contest["id"])
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        f.call("pm", "task.dispatch", admission=f.admission)


if __name__ == "__main__":
    unittest.main(verbosity=2)
