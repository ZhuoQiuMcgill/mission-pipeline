"""Regression gate for runtime defects a downstream mission relayed after 2.1.0.

One test class per repaired defect, each driven through the normal v4 requests.
"""
import unittest
from unittest.mock import patch

from v4_support import Fixture, refuses


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
