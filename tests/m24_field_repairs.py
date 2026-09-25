"""Regression gate for runtime defects a downstream mission relayed after 2.1.0.

One test class per repaired defect, each driven through the normal v4 requests.
"""
import hashlib
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from v4_support import ROOT, Fixture, refuses
from mp_runtime.process import RuntimeRefusal
from mp_runtime.storage import digest

MP = ROOT / "skills/mission-pipeline/scripts/mp"


class FieldRepairTest(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)

    def close_mission(self):
        f = self.f
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        return f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"],
                      review=review["id"], closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)


class PlanRecordKeepsDispositions(FieldRepairTest):
    """A plan re-record restates the PM's text; it never strips a recorded disposition."""

    def replan(self, id, *extra):
        self.f.call("pm", "plan.record", id=id, mission="m", goals=["usable-report"], source_blob=self.f.blob,
                    obligations=[dict(id="o", goal="usable-report", description="actual usable report")] + list(extra))

    def test_deferred_cancelled_and_met_obligations_survive_a_re_record_and_the_mission_closes(self):
        f = self.f
        f.setup()
        later = dict(id="later", goal="usable-report", description="an optional appendix")
        dropped = dict(id="dropped", goal="usable-report", description="a withdrawn format")
        self.replan("p2", later, dropped)
        reason = f.engine.store.blobs.put(b"The appendix moves to the next mission.")
        f.call("pm", "obligation.defer", obligation="later", grant="g", domain="method", owner="next-pm", reason_blob=reason)
        f.call("pm", "obligation.cancel", obligation="dropped", grant="g", domain="method", owner="pm", reason_blob=reason)
        deferred = f.engine.object("obligation", "later")
        cancelled = f.engine.object("obligation", "dropped")
        f.accept()
        met = f.engine.object("obligation", "o")
        self.replan("p3", dict(later, description="an optional appendix, restated"), dropped)
        self.assertEqual("an optional appendix, restated", f.engine.object("obligation", "later")["description"])
        self.assertEqual(dict(deferred, description="an optional appendix, restated"), f.engine.object("obligation", "later"))
        self.assertEqual(cancelled, f.engine.object("obligation", "dropped"))
        self.assertEqual(met, f.engine.object("obligation", "o"))
        result = self.close_mission()
        self.assertEqual("CLOSED", result["status"])
        outcomes = {row["id"]: row for row in result["outcomes"]}
        self.assertEqual(("AUTHORIZED_DEFERRED", "g", "method", "next-pm", reason),
                         tuple(outcomes["later"][k] for k in ("status", "grant", "domain", "deferred_owner", "reason_blob")))
        self.assertEqual("AUTHORIZED_CANCELLED", outcomes["dropped"]["status"])
        self.assertEqual("pm", outcomes["dropped"]["cancelled_by"]["role"])
        self.assertEqual("MET", outcomes["o"]["status"])
        self.assertTrue(outcomes["o"]["evidence"])

    def test_the_defer_grant_is_still_checked_at_close_after_a_re_record(self):
        f = self.f
        f.setup()
        later = dict(id="later", goal="usable-report", description="an optional appendix")
        self.replan("p2", later)
        f.call("principal", "grant.record", id="g-defer", authority="a", source_blob=f.blob, scope="m",
               domains=["method"], permissions=["defer"])
        f.review_admit()
        f.call("pm", "obligation.defer", obligation="later", grant="g-defer", domain="method", owner="pm", reason_blob=f.blob)
        self.replan("p3", later)
        self.assertEqual("g-defer", f.engine.object("obligation", "later")["grant"])
        f.accept()
        f.call("principal", "grant.revoke", grant="g-defer")
        refuses(self, "AUTHORITY_CONFLICT", self.close_mission)

    def test_a_disposition_already_stripped_by_2_1_0_is_refused_by_name_and_recorded_again(self):
        f = self.f
        f.setup()
        later = dict(id="later", goal="usable-report", description="an optional appendix")
        self.replan("p2", later)
        f.call("pm", "obligation.defer", obligation="later", grant="g", domain="method", owner="pm", reason_blob=f.blob)
        with patch("mp_runtime.workflow.OBLIGATION_DISPOSITION", ()):  # 2.1.0's re-record kept the status only
            self.replan("p3", later)
        self.assertNotIn("grant", f.engine.object("obligation", "later"))
        f.accept()
        refuses(self, "DEFERRAL_INCOMPLETE", self.close_mission)
        f.call("pm", "obligation.defer", obligation="later", grant="g", domain="method", owner="pm", reason_blob=f.blob)
        self.assertEqual("CLOSED", self.close_mission()["status"])


class BundleSnapshotsFollowAdmission(FieldRepairTest):
    """Declared outputs need snapshots once their task could have produced them, not before."""

    def record_task(self, id, obligations, outputs, wave=1):
        f = self.f
        f.call("pm", "task.record", id=id, mission="m", obligations=obligations, grant="g", domain="method",
               effects=["write-report"], allowed_effects=["write-report"], inputs=[f.blob], source_blob=f.blob,
               write_paths=outputs, outputs=outputs, wave=wave)

    def refusal(self, call):
        with self.assertRaises(RuntimeRefusal) as caught:
            call()
        return caught.exception

    def test_a_later_waves_unadmitted_outputs_do_not_block_an_earlier_waves_bundle(self):
        f = self.f
        f.setup()
        self.record_task("t-next", ["o"], ["appendix.txt"], wave=2)
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="wave-1", items=[])["bundle"]
        self.assertEqual("READY", bundle["status"])
        cell = f.call("calibrator", "calibration.record", bundle=bundle["id"], wave=1, outcome="ALIGNED",
                      source_blob=f.blob)["calibration"]
        self.assertEqual("ALIGNED", cell["outcome"])
        # The unstarted task is still unfinished work: the close refuses it by name.
        refuses(self, "CURRENT_ACCEPTANCE_REQUIRED", self.close_mission)

    def test_an_admitted_task_with_a_missing_delivery_still_refuses_the_bundle(self):
        f = self.f
        f.setup()
        self.record_task("t2", ["o"], ["appendix.txt"])
        f.call("supervisor", "plan.review", id="pr-t2", plan="p", tasks=["t", "t2"], outcome="PASS", source_blob=f.blob)
        f.call("pm", "task.admit", id="ad-t2", task="t2", review="pr-t2")
        f.accept()
        refused = self.refusal(lambda: f.call("pm", "bundle.record", mission="m", target="close", items=[]))
        self.assertEqual(("INPUT_INCOMPLETE", "appendix.txt", "t2"),
                         (refused.code, refused.context["path"], refused.context["task"]))

    def test_a_task_admitted_after_the_bundle_is_held_to_its_outputs_at_calibration_and_close(self):
        f = self.f
        f.setup()
        f.call("pm", "plan.record", id="p2", mission="m", goals=["usable-report"], source_blob=f.blob,
               obligations=[dict(id="o", goal="usable-report", description="actual usable report"),
                            dict(id="extra", goal="usable-report", description="a withdrawn appendix")])
        f.call("pm", "obligation.cancel", obligation="extra", grant="g", domain="method", owner="pm", reason_blob=f.blob)
        self.record_task("t2", ["extra"], ["appendix.txt"])
        f.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        f.call("supervisor", "plan.review", id="pr-t2", plan="p2", tasks=["t2"], outcome="PASS", source_blob=f.blob)
        f.call("pm", "task.admit", id="ad-t2", task="t2", review="pr-t2")
        refuses(self, "INPUT_INCOMPLETE", lambda: f.call("calibrator", "calibration.record", bundle=bundle["id"],
                wave=1, outcome="ALIGNED", source_blob=f.blob))
        self.assertEqual("INPUT_INCOMPLETE", f.call("calibrator", "calibration.record", bundle=bundle["id"], wave=1,
                         outcome="INPUT_INCOMPLETE", source_blob=f.blob)["calibration"]["outcome"])
        refused = self.refusal(lambda: f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"],
                               review=review["id"], closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob))
        self.assertEqual(("INPUT_INCOMPLETE", "t2"), (refused.code, refused.context["task"]))


class DecisionDomainMatchesItsTasks(FieldRepairTest):
    """A decision naming a task of another domain would govern nothing, so it is refused."""

    def decide(self, **data):
        f = self.f
        return f.call("pm", "decision.record", mission="m", effects={"layout": "narrow"}, rationale_blob=f.blob,
                      choice="a choice about named tasks", **data)

    def test_naming_a_task_of_another_domain_is_refused_with_both_domains(self):
        f = self.f
        f.setup()
        f.call("pm", "task.record", id="t-content", mission="m", obligations=["o"], grant="g", domain="content",
               effects=["write-report"], allowed_effects=["write-report"], inputs=[f.blob], source_blob=f.blob,
               write_paths=["text.md"], outputs=["text.md"])
        for tasks in (["t-content"], ["t", "t-content"]):
            with self.subTest(tasks=tasks):
                with self.assertRaises(RuntimeRefusal) as caught:
                    self.decide(id="d-mixed", grant="g", domain="method", tasks=tasks)
                self.assertEqual("DECISION_DOMAIN_MISMATCH", caught.exception.code)
                self.assertEqual({"task": "t-content", "task_domain": "content", "decision_domain": "method"},
                                 caught.exception.context)
        self.assertNotIn("d-mixed", [id for kind, id in f.engine.store.read() if kind == "decision"])
        self.assertEqual(["t"], self.decide(id="d-method", grant="g", domain="method", tasks=["t"])["decision"]["tasks"])
        f.call("principal", "grant.record", id="g-content", authority="a", source_blob=f.blob, scope="m",
               domains=["method", "content"], permissions=["choose", "revise"])
        self.decide(id="d-content", grant="g-content", domain="content", tasks=["t-content"])
        # A revision inherits its predecessor's tasks, and is held to the same rule.
        refuses(self, "DECISION_DOMAIN_MISMATCH",
                lambda: self.decide(id="d-moved", grant="g-content", domain="method", revises="d-content"))
        self.assertTrue(f.engine.object("decision", "d-content")["current"])


class WriteLimitIsStated(FieldRepairTest):
    """The 8 MiB work.write cap is unchanged; its refusal now names the limit and the size."""

    def test_an_oversized_write_names_the_limit_and_the_file_size(self):
        f = self.f
        f.setup()
        limit = 8 * 1024 * 1024
        current = hashlib.sha256((f.root / "verify.py").read_bytes()).hexdigest()
        oversized = f.engine.store.blobs.put(b"x" * (limit + 1))
        with self.assertRaises(RuntimeRefusal) as caught:
            f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py",
                   source_blob=oversized, expected_sha256=current)
        refused = caught.exception
        self.assertEqual("INVALID_INPUT", refused.code)
        self.assertIn("8388608 bytes (8 MiB)", refused.detail)
        self.assertIn("8388609 bytes", refused.detail)
        self.assertEqual({"limit": limit, "size": limit + 1, "path": "verify.py"}, refused.context)
        at_limit = f.engine.store.blobs.put(b"x" * limit)
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py",
               source_blob=at_limit, expected_sha256=current)
        self.assertEqual(limit, (f.root / "verify.py").stat().st_size)


class TaskQueryReportsAdmission(FieldRepairTest):
    """`query task` keeps the stored row and adds the admission and acceptance a reader means."""

    def query(self, id=None):
        return self.f.engine.handle({"action": "query", "data": {"kind": "task", "id": id}})

    def cli_query(self, id):
        result = subprocess.run([sys.executable, str(MP), "--root", str(self.f.root), "--actor", "pm", "query", "task", id],
                                capture_output=True, cwd=ROOT.parent, timeout=60)
        self.assertEqual(0, result.returncode, (result.stdout, result.stderr))
        return json.loads(result.stdout)

    def test_admission_and_acceptance_are_derived_beside_the_unchanged_stored_row(self):
        f = self.f
        f.setup()
        f.call("pm", "task.record", id="t-later", mission="m", obligations=["o"], grant="g", domain="method",
               effects=["write-report"], allowed_effects=["write-report"], inputs=[f.blob], source_blob=f.blob,
               write_paths=["appendix.txt"], outputs=["appendix.txt"], wave=2)
        reply = self.query("t")
        self.assertEqual(f.engine.object("task", "t"), reply["object"])
        self.assertEqual("NOT_ADMITTED", reply["object"]["status"])
        self.assertIn("record status", reply["note"])
        self.assertEqual({"admission": "ADMITTED", "admission_id": f.admission, "acceptance": "NOT_ACCEPTED",
                          "acceptance_report": None}, reply["derived"]["t"])
        accepted = f.accept()["report"]
        admitted_and_accepted = {"admission": "ADMITTED", "admission_id": f.admission, "acceptance": "ACCEPTED",
                                 "acceptance_report": accepted["id"]}
        self.assertEqual(admitted_and_accepted, self.query("t")["derived"]["t"])
        cli = self.cli_query("t")
        self.assertEqual("NOT_ADMITTED", cli["object"]["status"])
        self.assertEqual(admitted_and_accepted, cli["derived"]["t"])
        listed = self.query()
        self.assertEqual({"t", "t-later"}, set(listed["derived"]))
        self.assertEqual({"admission": "NOT_ADMITTED", "admission_id": None, "acceptance": "NOT_ACCEPTED",
                          "acceptance_report": None}, listed["derived"]["t-later"])
        # A changed authority stales the admission of an unchanged task, not its acceptance.
        f.call("principal", "grant.record", id="g-more", authority="a", source_blob=f.blob, scope="m",
               domains=["method"], permissions=["choose"])
        self.assertEqual(dict(admitted_and_accepted, admission="STALE"), self.query("t")["derived"]["t"])
        # The stored row's digest still serves `revises`; the revision stales both derived states.
        task = self.query("t")["object"]
        f.call("pm", "task.record", **dict(task, revises=digest(task), inputs=[f.blob, f.table]))
        self.assertEqual(dict(admitted_and_accepted, admission="STALE", acceptance="STALE"),
                         self.query("t")["derived"]["t"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
