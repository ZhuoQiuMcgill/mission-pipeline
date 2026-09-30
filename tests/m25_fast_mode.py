"""Real receipt lifecycles, scoped freshness and authority boundaries for 3.0."""
import json
import unittest

from v4_support import Fixture, refuses
from mp_runtime.storage import digest
from mp_runtime.workflow import Actor


class FastMode(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.f.setup()

    def configure(self, kind="execution", **extra):
        f = self.f
        environment = extra.pop("verification_environment", "env")
        task = f.engine.object("task", "t")
        fields = dict(id="t", mission="m", obligations=["o"], grant="g", domain="method",
            effects=["write-report"], allowed_effects=["write-report"], inputs=[f.blob], source_blob=f.blob,
            write_paths=["verify.py"], outputs=["report.txt"], work_type=kind,
            criteria={"o": "Actual usable report"}, priority=10,
            workers=[dict(id="build", write_paths=["verify.py"], outputs=["report.txt"])], revises=digest(task))
        fields.update(extra)
        f.call("pm", "task.record", **fields)
        f.call("pm", "requirement.record", id="fast-r", task="t", argv=["{canonical}"] if environment == "can" else ["{python}", "verify.py"],
               inputs=["verify.py"], environment=environment, scope="closing",
               outputs=[dict(path="report.txt", destination="report.txt")])
        f.review_admit()
        f.call("pm", "secretary.delegate", id="sd", mission="m", decision="d", tasks=["t"],
               operations=["issue", "dispatch", "refresh", "repair", "schedule", "escalate"], source_blob=f.blob)
        f.call("secretary", "receipt.issue", id="wr", task="t", admission=f.admission, delegation="sd")

    def ready(self):
        f = self.f
        snapshot = f.call("architect", "receipt.snapshot", receipt="wr")
        self.assertEqual("CURRENT", snapshot["status"], snapshot)
        f.call("architect", "readiness.record", receipt="wr", outcome="READY", basis=snapshot["basis"], source_blob=f.blob)

    def dispatch(self):
        f = self.f
        self.ready()
        f.call("secretary", "receipt.dispatch", receipt="wr", delegation="sd")
        return f.call("constructor", "receipt.claim", receipt="wr", worker="build")["claim"]

    def construct(self):
        f = self.f
        claim = self.dispatch()
        self.run = f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission)["run"]
        self.assertTrue(self.run["satisfied"], self.run)
        result = f.call("constructor", "completion.record", receipt="wr", claim=claim["id"], source_blob=f.blob)
        self.assertTrue(result["constructed"])

    def accept(self, **extra):
        f = self.f
        basis = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        args = dict(receipt="wr", outcome="ACCEPTED", basis=basis, source_blob=f.blob,
                    criteria={"o": {"status": "met", "evidence": [self.run["id"]]}})
        args.update(extra)
        return f.call("stabilizer", "acceptance.record", **args)

    def test_execution_has_one_acceptance_and_closes_through_existing_audit(self):
        f = self.f
        self.configure()
        self.construct()
        accepted = self.accept()
        state = f.engine.store.read()
        reports = [v["data"] for (kind, _), v in state.items() if kind == "report"]
        self.assertEqual(["development", "acceptance"], [r["kind"] for r in reports])
        self.assertNotIn("source_fields", reports[-1])
        queue = f.call("pm", "queue.snapshot", mission="m")
        self.assertEqual("ACCEPTED", queue["tasks"][0]["state"])
        self.assertTrue(queue["tasks"][0]["qualified"])
        f.call("pm", "consume", admission=f.admission)
        bundle = f.call("pm", "bundle.record", mission="m", target="mission-close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        self.assertEqual("CLOSED", f.call("pm", "mission.close", mission="m", bundle=bundle["id"],
            audit=audit["id"], review=review["id"], closing_run=self.run["id"], grant="g", domain="method", source_blob=f.blob)["status"])
        self.assertTrue(f.engine.store.doctor()["ok"])

    def test_readiness_claim_and_worker_scope_are_required(self):
        f = self.f
        self.configure()
        refuses(self, "READINESS_REQUIRED", lambda: f.call("secretary", "receipt.dispatch", receipt="wr", delegation="sd"))
        refuses(self, "READINESS_REQUIRED", lambda: f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission))
        self.ready()
        refuses(self, "DISPATCH_REQUIRED", lambda: f.call("constructor", "receipt.claim", receipt="wr", worker="build"))
        f.call("secretary", "receipt.dispatch", receipt="wr", delegation="sd")
        refuses(self, "WORKER_CLAIM_REQUIRED", lambda: f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission))
        f.call("constructor", "receipt.claim", receipt="wr", worker="build")
        refuses(self, "WORKER_SCOPE", lambda: f.call("constructor", "work.write", task="t", admission=f.admission,
                path="outside.py", source_blob=f.blob))

    def test_actual_output_changes_stale_acceptance_without_destroying_history(self):
        f = self.f
        self.configure()
        self.construct()
        accepted = self.accept()["acceptance"]["id"]
        (f.root / "report.txt").write_text("tampered", encoding="utf-8")
        before = len(f.engine.store.events())
        queue = f.call("pm", "queue.snapshot", mission="m")
        self.assertEqual(before, len(f.engine.store.events()))
        self.assertEqual("STALE", queue["tasks"][0]["state"])
        self.assertEqual(accepted, queue["tasks"][0]["recorded_acceptance"])
        self.assertFalse(queue["tasks"][0]["qualified"])
        refuses(self, "STALE_EXECUTION_OUTPUT", lambda: f.call("pm", "consume", admission=f.admission))

    def test_unrelated_coordination_does_not_invalidate_candidate(self):
        f = self.f
        self.configure()
        self.construct()
        before = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        f.call("secretary", "secretary.coordinate", task="t", delegation="sd", operation="refresh", source_blob=f.blob)
        self.assertEqual(before, f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"])
        self.accept()

    def test_relevant_authority_refresh_versions_receipt_without_resetting_cycles(self):
        f = self.f
        self.configure()
        self.construct()
        original = f.engine.object("work_receipt", "wr")
        f.call("pm", "decision.record", id="d2", mission="m", grant="g", domain="method", tasks=["t"],
               effects={"format": "html"}, rationale_blob=f.blob, choice="Clarified current delivery decision")
        f.review_admit()
        fresh = f.call("secretary", "receipt.issue", id="wr2", task="t", admission=f.admission, delegation="sd")["receipt"]
        self.assertEqual(original["contract_digest"], fresh["contract_digest"])
        self.assertEqual(2, fresh["version"])
        self.assertFalse(f.engine.object("work_receipt", "wr")["current"])
        snapshot = f.call("architect", "receipt.snapshot", receipt="wr2")
        f.call("architect", "readiness.record", receipt="wr2", outcome="READY", basis=snapshot["basis"], source_blob=f.blob)
        f.call("secretary", "receipt.dispatch", receipt="wr2", delegation="sd")
        self.assertEqual(2, f.engine.object("budget", "t:receipt_cycles")["count"])

    def test_managed_workers_cannot_expand_reads_to_unrelated_receipts(self):
        from mp_runtime.managed import ManagedBroker
        f = self.f
        self.configure()
        f.call("pm", "task.record", id="other", mission="m", obligations=[], grant="g", domain="method", source_blob=f.blob,
               work_type="execution", outputs=["other.txt"], write_paths=["other.txt"], criteria={"other": "Other result"},
               workers=[dict(id="other", outputs=["other.txt"], write_paths=["other.txt"])])
        broker = ManagedBroker(f.engine)
        worker = broker.seat("constructor", "m", ["t"])
        result = broker.tool(worker, {"tool": "refresh_packet", "full": True})
        self.assertFalse(any(r["kind"] == "task" and r["object"]["id"] == "other" for r in result["records"]))
        refuses(self, "INPUT_OUTSIDE_PACKET", lambda: broker.tool(worker, {"tool": "submit", "request":
            dict(action="query", data=dict(kind="task", id="other"))}))
        pm = broker.seat("pm", "m", ["t"])
        result = broker.tool(pm, {"tool": "refresh_packet", "full": True})
        self.assertTrue(any(r["kind"] == "task" and r["object"]["id"] == "other" for r in result["records"]))

    def test_active_task_replacement_releases_paths_and_preserves_cycle_budget(self):
        f = self.f
        self.configure()
        self.dispatch()
        old_receipt = f.engine.object("work_receipt", "wr")
        old_dispatch = next(v["data"] for (kind, _), v in f.engine.store.read().items()
                            if kind == "receipt_dispatch")
        replacement = dict(f.engine.object("task", "t"), id="replacement", required_runs=["replacement-r"])
        f.call("pm", "task.replace", previous="t", task=replacement)
        f.call("pm", "requirement.record", id="replacement-r", task="replacement",
               argv=["{python}", "verify.py"], inputs=["verify.py"], environment="env", scope="closing",
               outputs=[dict(path="report.txt", destination="report.txt")])
        review = f.call("supervisor", "plan.review", plan="p", tasks=["replacement"],
                        outcome="PASS", source_blob=f.blob)["review"]
        admission = f.call("pm", "task.admit", task="replacement", review=review["id"])["admission"]
        f.call("pm", "secretary.delegate", id="replacement-delegation", mission="m", decision="d",
               tasks=["replacement"], operations=["issue", "dispatch"], source_blob=f.blob)
        f.call("secretary", "receipt.issue", id="replacement-receipt", task="replacement",
               admission=admission["id"], delegation="replacement-delegation")
        snapshot = f.call("architect", "receipt.snapshot", receipt="replacement-receipt")
        f.call("architect", "readiness.record", receipt="replacement-receipt", outcome="READY",
               basis=snapshot["basis"], source_blob=f.blob)
        dispatch = f.call("secretary", "receipt.dispatch", receipt="replacement-receipt",
                          delegation="replacement-delegation")["dispatch"]
        self.assertEqual(2, dispatch["cycle"])
        self.assertEqual(2, f.engine.object("budget", "t:receipt_cycles")["count"])
        self.assertEqual("t", f.engine.object("task", "replacement")["lineage"])
        self.assertFalse(f.engine.object("work_receipt", "wr")["current"])
        self.assertEqual(old_receipt["contract"], f.engine.object("work_receipt", "wr")["contract"])
        self.assertFalse(f.engine.object("receipt_dispatch", old_dispatch["id"])["active"])
        refuses(self, "SUPERSEDED_RECEIPT", lambda: f.call("constructor", "receipt.claim", receipt="wr", worker="build"))

    def test_unrelated_grant_does_not_stale_a_receipt_or_its_acceptance(self):
        f = self.f
        self.configure()
        self.construct()
        before = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        f.call("principal", "grant.record", id="unrelated-grant", authority="a", source_blob=f.blob,
               scope="m", domains=["other-domain"], permissions=["choose"])
        self.assertEqual(before, f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"])
        f.call("secretary", "secretary.coordinate", task="t", delegation="sd", operation="refresh", source_blob=f.blob)
        self.accept()

    def test_priority_and_completion_annotations_preserve_qualification(self):
        f = self.f
        self.configure()
        self.construct()
        before = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        f.call("pm", "schedule.record", task="t", priority=99, source_blob=f.blob)
        completion = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "completion")
        f.call("constructor", "completion.annotate", completion=completion["id"], source_blob=f.blob)
        self.assertEqual(before, f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"])
        self.assertEqual(99, f.call("pm", "queue.snapshot", mission="m")["tasks"][0]["priority"])
        self.accept()
        self.assertEqual(1, f.engine.object("budget", "t:receipt_cycles")["count"])

    def test_missing_review_input_can_be_completed_without_another_product_cycle(self):
        f = self.f
        self.configure()
        self.construct()
        verdict = f.call("stabilizer", "acceptance.record", receipt="wr", outcome="INPUT_INCOMPLETE",
                         findings=["Need to inspect original output evidence"], source_blob=f.blob)["acceptance"]
        self.accept(revises=verdict["id"])
        self.assertEqual(1, f.engine.object("budget", "t:receipt_cycles")["count"])

    def test_public_cli_exposes_version_and_read_only_queue(self):
        import subprocess
        import sys
        from v4_support import ROOT
        f = self.f
        self.configure()
        mp = ROOT / "skills/mission-pipeline/scripts/mp"
        capabilities = subprocess.run([sys.executable, str(mp), "--root", str(f.root), "capabilities"], capture_output=True, check=True)
        self.assertEqual("3.0.0", json.loads(capabilities.stdout)["version"])
        before = len(f.engine.store.events())
        request = dict(action="queue.snapshot", data={"mission": "m"})
        result = subprocess.run([sys.executable, str(mp), "--root", str(f.root), "--actor", "secretary", "api", "--stdio"],
                                input=json.dumps(request).encode(), capture_output=True, check=True)
        self.assertEqual("t", json.loads(result.stdout)["tasks"][0]["id"])
        self.assertEqual(before, len(f.engine.store.events()))

    def test_missing_interface_is_blocked_and_changed_input_requires_reinspection(self):
        f = self.f
        self.configure(prerequisites=[{"path": "interface.json"}])
        snap = f.call("architect", "receipt.snapshot", receipt="wr")
        self.assertEqual("PREREQUISITE_MISSING", snap["reasons"][0]["code"])
        f.call("architect", "readiness.record", receipt="wr", outcome="BLOCKED", gaps=["interface.json missing"], source_blob=f.blob)
        f.call("secretary", "secretary.coordinate", task="t", delegation="sd", operation="escalate", source_blob=f.blob)
        (f.root / "interface.json").write_text("v1", encoding="utf-8")
        self.ready()
        (f.root / "interface.json").write_text("v2", encoding="utf-8")
        refuses(self, "STALE_READINESS", lambda: f.call("secretary", "receipt.dispatch", receipt="wr", delegation="sd"))

    def test_undefined_design_choice_escalates_in_queue(self):
        f = self.f
        self.configure(decision_dependencies=["future-design"])
        queue = f.call("secretary", "queue.snapshot", mission="m")
        self.assertEqual(["t"], queue["escalations"])
        self.assertEqual("NEEDS_DECISION", queue["tasks"][0]["state"])

    def test_receipt_review_requires_real_verification_definitions(self):
        f = self.f
        task = f.engine.object("task", "t")
        f.call("pm", "task.record", id="t", mission="m", obligations=["o"], grant="g", domain="method",
               source_blob=f.blob, required_runs=["not-defined"], revises=digest(task))
        refuses(self, "VERIFICATION_DEFINITION_REQUIRED", lambda: f.review_admit())

    def test_pre_upgrade_review_needs_definition_binding_before_new_admission(self):
        f = self.f
        review = next(v["data"] for (kind, _), v in f.engine.store.read().items() if kind == "review" and v["data"]["kind"] == "plan")
        def old_review_fixture(state):
            stored = state[("review", review["id"])]["data"]
            stored.pop("receipt_contracts")
            stored.pop("receipt_authorities")
            return {"ok": True}
        f.engine.store.transact(dict(action="fixture.pre_upgrade_review", request_id="legacy-review-fixture", data={}),
                                Actor("principal", "fixture").record(), old_review_fixture)
        # Existing admissions keep their historical meaning; new admission binds definitions.
        refuses(self, "STALE_PLAN_REVIEW", lambda: f.call("pm", "task.admit", task="t", review=review["id"]))
        f.review_admit()

    def test_registered_canonical_executor_is_a_valid_prerequisite(self):
        import sys
        f = self.f
        (f.root / "verify.py").write_text("import sys\nfrom pathlib import Path\n"
            "(Path(sys.argv[1]) / 'report.txt').write_text('A usable canonical report', encoding='utf-8')\n", encoding="utf-8")
        f.call("principal", "canonical.register", id="can", executor_argv=[sys.executable], expected_version="Python",
               required_inputs=["verify.py"], command=["verify.py", "{out}"])
        self.configure(verification_environment="can")
        self.construct()
        self.accept()

    def test_incomplete_plan_can_be_recorded_without_pretending_it_passes(self):
        f = self.f
        task = f.engine.object("task", "t")
        f.call("pm", "task.record", id="t", mission="m", obligations=["o"], grant="g", domain="method", source_blob=f.blob,
               required_runs=["undefined-check"], revises=digest(task))
        review = f.call("supervisor", "plan.review", plan="p", tasks=["t"], outcome="INPUT_INCOMPLETE", source_blob=f.blob)["review"]
        self.assertEqual("INPUT_INCOMPLETE", review["outcome"])

    def test_secretary_cannot_design_accept_or_use_revoked_delegation(self):
        f = self.f
        self.configure()
        refuses(self, "ROLE_FORBIDDEN", lambda: f.call("secretary", "decision.record", mission="m"))
        refuses(self, "ROLE_FORBIDDEN", lambda: f.call("secretary", "acceptance.record", receipt="wr", outcome="ACCEPTED"))
        f.call("principal", "grant.revoke", grant="g", source_blob=f.blob)
        refuses(self, "STALE_DELEGATION", lambda: f.call("secretary", "secretary.coordinate", task="t", delegation="sd", operation="refresh", source_blob=f.blob))

    def test_typed_paths_work_for_readiness_exports_and_managed_reads(self):
        from mp_runtime.managed import ManagedBroker
        f = self.f
        verify = {"relative_segments": ["verify.py"]}
        report = {"relative_segments": ["report.txt"]}
        interface = {"relative_segments": ["interface.json"]}
        (f.root / "interface.json").write_text("approved schema", encoding="utf-8")
        self.configure(write_paths=[verify], outputs=[report], prerequisites=[{"path": interface}],
            workers=[dict(id="build", write_paths=[verify], outputs=[report])])
        broker = ManagedBroker(f.engine)
        seat = broker.seat("architect", "m", ["t"])
        packet = broker.packet(seat)
        for blob in packet["input_manifest"]:
            broker.tool(seat, {"tool": "read_blob", "blob": blob})
        request = dict(action="readiness.record", request_id="typed-ready", data=dict(receipt="wr", outcome="READY",
            basis=f.call("architect", "receipt.snapshot", receipt="wr")["basis"], source_blob=f.blob))
        refuses(self, "INPUT_NOT_READ", lambda: broker.tool(seat, {"tool": "submit", "request": request}))
        broker.tool(seat, {"tool": "read_product", "task": "t", "path": interface})
        broker.tool(seat, {"tool": "submit", "request": request})
        self.construct()
        self.accept()
        bundle = f.call("pm", "bundle.record", mission="m", target="mission-close", items=[])["bundle"]
        self.assertEqual("READY", bundle["status"])

    def test_specialist_review_is_conditional_and_independent(self):
        f = self.f
        self.configure(specialist_review=True)
        self.construct()
        refuses(self, "CURRENT_INDEPENDENT_PASS_REQUIRED", lambda: self.accept())
        critique = f.call("crititor", "report.record", task="t", kind="critique", outcome="PASS",
                         criteria={"o": "met"}, admission=f.admission, source_blob=f.table)["report"]
        self.accept(critique=critique["id"])

    def test_independent_reviewer_rerun_refreshes_evidence_without_a_product_cycle(self):
        f = self.f
        self.configure(specialist_review=True)
        self.construct()
        before = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        original_output = (f.root / "report.txt").read_bytes()
        critique = f.call("crititor", "report.record", task="t", kind="critique", outcome="PASS",
                         criteria={"o": "met"}, admission=f.admission, source_blob=f.table)["report"]
        self.run = f.call("stabilizer", "run.execute", requirement="fast-r", admission=f.admission,
                          purpose="independent_check", reason="Independently verify the completed candidate")["run"]
        self.assertTrue(self.run["satisfied"])
        after = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        self.assertEqual(original_output, (f.root / "report.txt").read_bytes())
        self.assertEqual(before["product_digest"], after["product_digest"])
        self.assertEqual(before["completions"], after["completions"])
        self.assertEqual(before["development"], after["development"])
        self.assertNotEqual(before["runs"], after["runs"])
        self.assertEqual([self.run["id"]], after["runs"])
        refuses(self, "STALE_ACCEPTANCE_INPUT", lambda: self.accept(basis=before, critique=critique["id"]))
        self.accept(critique=critique["id"])
        self.assertEqual(1, f.engine.object("budget", "t:receipt_cycles")["count"])

    def test_failed_independent_reviewer_run_blocks_acceptance(self):
        f = self.f
        # A live external failure switch makes the same frozen verifier fail on
        # independent execution without changing its inputs or existing product.
        failure_switch = f.root / "independent-failure.flag"
        verifier = (f.root / "verify.py").read_text(encoding="utf-8")
        (f.root / "verify.py").write_text("from pathlib import Path\n"
            + "assert not Path(" + repr(str(failure_switch)) + ").exists(), 'independent check failed'\n"
            + verifier, encoding="utf-8")
        self.configure()
        self.construct()
        before = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        failure_switch.write_text("fail", encoding="utf-8")
        failed = f.call("stabilizer", "run.execute", requirement="fast-r", admission=f.admission,
                        purpose="independent_check", reason="Independently verify the completed candidate")["run"]
        self.assertFalse(failed["satisfied"])
        snapshot = f.call("stabilizer", "acceptance.snapshot", receipt="wr")
        self.assertEqual("REQUIRED_VERIFICATION_UNSATISFIED", snapshot["reasons"][0]["code"])
        refuses(self, "REQUIRED_VERIFICATION_UNSATISFIED", lambda: f.call("stabilizer", "acceptance.record",
                receipt="wr", outcome="ACCEPTED", basis=before, source_blob=f.blob,
                criteria={"o": {"status": "met", "evidence": [self.run["id"]]}}))
        self.assertEqual(1, f.engine.object("budget", "t:receipt_cycles")["count"])

    def test_disposed_task_does_not_unlock_or_demand_unproduced_outputs(self):
        f = self.f
        self.configure()
        f.call("pm", "task.record", id="downstream", mission="m", obligations=[], grant="g", domain="method",
               source_blob=f.blob, dependencies=["t"])
        f.call("pm", "task.dispose", task="t", outcome="CANCELLED", grant="g", owner="principal", source_blob=f.blob)
        f.call("pm", "obligation.cancel", obligation="o", grant="g", domain="method", owner="principal", reason_blob=f.blob)
        views = {v["id"]: v for v in f.call("pm", "queue.snapshot", mission="m")["tasks"]}
        self.assertEqual("CANCELLED", views["t"]["state"])
        self.assertFalse(views["t"]["qualified"])
        self.assertEqual("DEPENDENCY_DISPOSED", views["downstream"]["reasons"][0]["code"])
        bundle = f.call("pm", "bundle.record", mission="m", target="mission-close", items=[])["bundle"]
        self.assertEqual("READY", bundle["status"])

    def test_exploration_checks_question_criteria_beyond_goal_obligations(self):
        f = self.f
        self.configure("exploration", criteria={"o": "Usable report", "question": "Honest experiment finding and stopping condition"})
        self.dispatch()
        f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission)
        f.call("constructor", "report.record", task="t", kind="development", outcome="COMPLETE", source_blob=f.table, criteria={"o": "met"})
        refuses(self, "UNMET_OBLIGATION", lambda: f.call("crititor", "report.record", task="t", kind="critique", outcome="PASS",
               source_blob=f.table, criteria={"o": "met"}, admission=f.admission))
        table = f.engine.store.blobs.put(f.engine.store.blobs.get(f.table) + b"| question | honest negative finding and stopping condition | met | experiment data | R |\n")
        critique = f.call("crititor", "report.record", task="t", kind="critique", outcome="PASS", source_blob=table,
                         criteria={"o": "met", "question": "met"}, admission=f.admission)["report"]
        f.call("stabilizer", "report.record", task="t", kind="acceptance", outcome="ACCEPTED", source_blob=table,
               criteria={"o": "met", "question": "met"}, admission=f.admission, critique=critique["id"])
        self.assertTrue(f.call("pm", "queue.snapshot", mission="m")["tasks"][0]["qualified"])

    def test_secretary_scheduling_is_limited_and_does_not_change_contract(self):
        f = self.f
        self.configure()
        f.call("pm", "secretary.delegate", id="limited", mission="m", decision="d", tasks=["t"],
               operations=["schedule"], max_actions=1, priority_range=[0, 20], source_blob=f.blob)
        before = f.call("architect", "receipt.snapshot", receipt="wr")["basis"]
        refuses(self, "DELEGATION_SCOPE", lambda: f.call("secretary", "secretary.coordinate", task="t",
            delegation="limited", operation="schedule", priority=21, source_blob=f.blob))
        f.call("secretary", "secretary.coordinate", task="t", delegation="limited", operation="schedule", priority=20, source_blob=f.blob)
        self.assertEqual(before, f.call("architect", "receipt.snapshot", receipt="wr")["basis"])
        refuses(self, "BUDGET_EXHAUSTED", lambda: f.call("secretary", "secretary.coordinate", task="t",
            delegation="limited", operation="schedule", priority=19, source_blob=f.blob))
        f.call("pm", "secretary.delegate", id="expired", mission="m", decision="d", tasks=["t"],
               operations=["refresh"], expires=0, source_blob=f.blob)
        refuses(self, "STALE_DELEGATION", lambda: f.call("secretary", "secretary.coordinate", task="t",
            delegation="expired", operation="refresh", source_blob=f.blob))

    def test_acceptance_is_independent_and_cannot_skip_worker_completion(self):
        f = self.f
        self.configure()
        self.dispatch()
        refuses(self, "CONSTRUCTION_INCOMPLETE", lambda: f.call("stabilizer", "acceptance.record", receipt="wr", outcome="ACCEPTED", source_blob=f.blob))
        self.run = f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission)["run"]
        claim = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "worker_claim")
        f.call("constructor", "completion.record", receipt="wr", claim=claim["id"], source_blob=f.blob)
        engine = f.engine.with_actor(Actor("stabilizer", "seat:constructor"))
        refuses(self, "INDEPENDENCE_REQUIRED", lambda: engine.handle(dict(action="acceptance.record", request_id="independence",
            data=dict(receipt="wr", outcome="ACCEPTED", source_blob=f.blob))))
        self.accept()

    def test_repairs_are_bounded_and_need_a_secretary_route(self):
        f = self.f
        self.configure()
        for cycle in range(1, 4):
            self.construct()
            self.assertEqual("CONSTRUCTED", f.call("pm", "queue.snapshot", mission="m")["tasks"][0]["state"])
            f.call("stabilizer", "acceptance.record", receipt="wr", outcome="REPAIR_REQUIRED",
                   source_blob=f.blob, findings=["Concrete defect within the approved report behavior"])
            if cycle < 3:
                refuses(self, "REPAIR_ROUTE_REQUIRED", lambda: f.call("secretary", "receipt.dispatch", receipt="wr", delegation="sd"))
                f.call("secretary", "secretary.coordinate", task="t", delegation="sd", operation="repair", source_blob=f.blob)
        refuses(self, "BUDGET_EXHAUSTED", lambda: f.call("secretary", "secretary.coordinate", task="t", delegation="sd", operation="repair", source_blob=f.blob))
        self.assertEqual(3, f.engine.object("budget", "t:receipt_cycles")["count"])
        from mp_runtime.managed import ManagedBroker
        broker = ManagedBroker(f.engine)
        pm = broker.seat("pm", "m")
        compact = broker.packet(pm)
        full = broker.tool(pm, {"tool": "refresh_packet", "full": True})
        self.assertEqual(1, sum(r["kind"] == "run" for r in compact["records"]))
        self.assertEqual(2, sum(r["kind"] == "report" for r in compact["records"]))
        self.assertEqual(6, sum(r["kind"] == "report" for r in full["records"]))
        self.assertLess(len(json.dumps(compact)), len(json.dumps(full)))

    def test_failed_local_checks_stay_in_one_cycle_and_history_is_on_demand(self):
        import hashlib
        from mp_runtime.managed import ManagedBroker
        f = self.f
        self.configure()
        claim = self.dispatch()
        good = (f.root / "verify.py").read_bytes()
        bad = b"raise AssertionError('implementation check failed')\n"
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py",
               source_blob=f.engine.store.blobs.put(bad), expected_sha256=hashlib.sha256(good).hexdigest())
        failed = f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission)["run"]
        self.assertFalse(failed["satisfied"])
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py",
               source_blob=f.engine.store.blobs.put(good), expected_sha256=hashlib.sha256(bad).hexdigest())
        self.run = f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission)["run"]
        f.call("constructor", "completion.record", receipt="wr", claim=claim["id"], source_blob=f.blob)
        self.accept()
        self.assertEqual(1, f.engine.object("budget", "t:receipt_cycles")["count"])
        broker = ManagedBroker(f.engine)
        pm = broker.seat("pm", "m")
        compact = broker.packet(pm)
        full = broker.tool(pm, {"tool": "refresh_packet", "full": True})
        self.assertEqual(1, sum(r["kind"] == "run" for r in compact["records"]))
        self.assertEqual(2, sum(r["kind"] == "run" for r in full["records"]))
        history = broker.tool(pm, {"tool": "submit", "request": dict(action="query", data={"kind": "run", "id": failed["id"]})})
        self.assertFalse(history["object"]["satisfied"])

    def test_exploration_keeps_independent_critique_chain(self):
        f = self.f
        self.configure("exploration")
        self.dispatch()
        f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission)
        f.call("constructor", "report.record", task="t", kind="development", outcome="COMPLETE", source_blob=f.table, criteria={"o": "met"})
        critique = f.call("crititor", "report.record", task="t", kind="critique", outcome="PASS", source_blob=f.table,
                         criteria={"o": "met"}, admission=f.admission)["report"]
        f.call("stabilizer", "report.record", task="t", kind="acceptance", outcome="ACCEPTED", source_blob=f.table,
               criteria={"o": "met"}, admission=f.admission, critique=critique["id"])
        self.assertEqual("ACCEPTED", f.call("pm", "queue.snapshot", mission="m")["tasks"][0]["state"])

    def test_exploration_prerequisite_changes_stale_acceptance_and_block_consumption(self):
        f = self.f
        (f.root / "interface.txt").write_text("approved interface", encoding="utf-8")
        self.configure("exploration", prerequisites=[{"path": "interface.txt"}])
        self.dispatch()
        f.call("constructor", "run.execute", requirement="fast-r", admission=f.admission)
        f.call("constructor", "report.record", task="t", kind="development", outcome="COMPLETE",
               source_blob=f.table, criteria={"o": "met"})
        critique = f.call("crititor", "report.record", task="t", kind="critique", outcome="PASS",
                         source_blob=f.table, criteria={"o": "met"}, admission=f.admission)["report"]
        accepted = f.call("stabilizer", "report.record", task="t", kind="acceptance", outcome="ACCEPTED",
                          source_blob=f.table, criteria={"o": "met"}, admission=f.admission,
                          critique=critique["id"])["report"]
        self.assertEqual("wr", accepted["receipt"])
        f.call("pm", "task.record", id="downstream", mission="m", obligations=[], grant="g", domain="method",
               source_blob=f.blob, dependencies=["t"])
        (f.root / "interface.txt").write_text("materially changed interface", encoding="utf-8")
        before = len(f.engine.store.events())
        views = {v["id"]: v for v in f.call("pm", "queue.snapshot", mission="m")["tasks"]}
        self.assertEqual(before, len(f.engine.store.events()))
        self.assertEqual("STALE", views["t"]["state"])
        self.assertFalse(views["t"]["qualified"])
        self.assertEqual(accepted["id"], views["t"]["recorded_acceptance"])
        self.assertEqual("BLOCKED", views["downstream"]["state"])
        refuses(self, "STALE_READINESS", lambda: f.call("pm", "consume", admission=f.admission))
        review = f.call("supervisor", "plan.review", plan="p", tasks=["t", "downstream"],
                        outcome="PASS", source_blob=f.blob)["review"]
        refuses(self, "STALE_READINESS", lambda: f.call("pm", "task.admit", task="downstream", review=review["id"]))

    def test_parallel_workers_are_scoped_and_acceptance_waits_for_both(self):
        f = self.f
        task = f.engine.object("task", "t")
        workers = [dict(id="a", write_paths=["a.txt"], outputs=["a.txt"]),
                   dict(id="b", write_paths=["b.txt"], outputs=["b.txt"])]
        f.call("pm", "task.record", id="t", mission="m", obligations=["o"], grant="g", domain="method", source_blob=f.blob,
               write_paths=["a.txt", "b.txt"], outputs=["a.txt", "b.txt"], work_type="execution", workers=workers,
               criteria={"o": "Both actual outputs fit the agreed integrated result"}, revises=digest(task))
        f.review_admit()
        f.call("pm", "secretary.delegate", id="sd", mission="m", decision="d", tasks=["t"],
               operations=["issue", "dispatch"], source_blob=f.blob)
        f.call("secretary", "receipt.issue", id="wr", task="t", admission=f.admission, delegation="sd")
        self.ready()
        f.call("secretary", "receipt.dispatch", receipt="wr", delegation="sd")
        for index, worker in enumerate(workers):
            engine = f.engine.with_actor(Actor("constructor", "worker:" + worker["id"]))
            def call(action, **data):
                return engine.handle(dict(action=action, data=data, request_id="parallel-" + str(next(f.n))))
            claim = call("receipt.claim", receipt="wr", worker=worker["id"])["claim"]
            if index == 0:
                refuses(self, "WORKER_SCOPE", lambda: call("work.write", task="t", admission=f.admission, path="b.txt", source_blob=f.blob))
            call("work.write", task="t", admission=f.admission, path=worker["outputs"][0], source_blob=f.blob)
            call("delivery.record", task="t", admission=f.admission, path=worker["outputs"][0])
            completion = call("completion.record", receipt="wr", claim=claim["id"], source_blob=f.blob)
            self.assertEqual(index == 1, completion["constructed"])
            if index == 0:
                self.assertEqual("CONSTRUCTION_INCOMPLETE", f.call("stabilizer", "acceptance.snapshot", receipt="wr")["reasons"][0]["code"])
        basis = f.call("stabilizer", "acceptance.snapshot", receipt="wr")["basis"]
        f.call("stabilizer", "acceptance.record", receipt="wr", basis=basis, outcome="ACCEPTED", source_blob=f.blob,
               criteria={"o": {"status": "met", "evidence": [sha for _, sha in basis["outputs"]]}})
        self.assertTrue(f.call("pm", "queue.snapshot", mission="m")["tasks"][0]["qualified"])

    def test_mixed_graph_unlocks_only_accepted_current_output(self):
        f = self.f
        self.configure()
        f.call("pm", "task.record", id="parent", mission="m", obligations=["o"], grant="g", domain="method", source_blob=f.blob, work_type="milestone")
        f.call("pm", "task.record", id="research", mission="m", obligations=[], grant="g", domain="method", source_blob=f.blob,
               work_type="exploration", parent="parent", dependencies=["t"], outputs=["findings.txt"], write_paths=["findings.txt"],
               criteria={"question": "Investigate the accepted output within the agreed stop conditions"},
               workers=[dict(id="investigate", write_paths=["findings.txt"], outputs=["findings.txt"])])
        before = f.call("pm", "queue.snapshot", mission="m")
        views = {v["id"]: v for v in before["tasks"]}
        self.assertEqual("BLOCKED", views["research"]["state"])
        self.assertEqual(["research"], views["t"]["unlocks"])
        self.construct()
        self.assertEqual("BLOCKED", {v["id"]: v for v in f.call("pm", "queue.snapshot", mission="m")["tasks"]}["research"]["state"])
        self.accept()
        after = {v["id"]: v for v in f.call("pm", "queue.snapshot", mission="m")["tasks"]}
        self.assertEqual("PLANNED", after["research"]["state"])
        (f.root / "report.txt").write_text("stale", encoding="utf-8")
        after = {v["id"]: v for v in f.call("pm", "queue.snapshot", mission="m")["tasks"]}
        self.assertEqual("BLOCKED", after["research"]["state"])

    def test_secretary_issues_from_review_without_an_extra_pm_admission_turn(self):
        f = self.f
        self.configure()
        # A second receipt in the same delegation demonstrates scoped admission.
        f.call("pm", "task.record", id="u", mission="m", obligations=[], grant="g", domain="method", source_blob=f.blob,
               work_type="execution", outputs=["u.txt"], write_paths=["u.txt"], criteria={"u": "Reviewed output"},
               workers=[dict(id="u", outputs=["u.txt"], write_paths=["u.txt"])])
        f.call("supervisor", "plan.review", id="u-review", plan="p", tasks=["t", "u"], active_tasks=["u"], outcome="PASS", source_blob=f.blob)
        f.call("pm", "secretary.delegate", id="u-delegation", mission="m", decision="d", tasks=["u"], operations=["issue"], source_blob=f.blob)
        issued = f.call("secretary", "receipt.issue", id="u-receipt", task="u", review="u-review", delegation="u-delegation")
        admission = f.engine.object("admission", issued["receipt"]["admission"])
        self.assertEqual("secretary", admission["author"]["role"])
        self.assertEqual("secretary", f.engine.object("work_receipt", "u-receipt")["author"]["role"])

    def test_future_milestones_need_no_fabricated_executable_definitions(self):
        f = self.f
        self.configure()
        f.call("pm", "task.record", id="future", mission="m", obligations=["o"], grant="g", domain="method", source_blob=f.blob, work_type="milestone")
        f.call("supervisor", "plan.review", id="graph-review", plan="p", tasks=["t", "future"], active_tasks=["t"], outcome="PASS", source_blob=f.blob)
        refuses(self, "MILESTONE_NOT_EXECUTABLE", lambda: f.call("pm", "task.admit", task="future", review="graph-review"))

    def test_task_bundle_ignores_unrelated_unfinished_receipts(self):
        f = self.f
        self.configure()
        self.construct()
        f.call("pm", "task.record", id="u", mission="m", obligations=[], grant="g", domain="method", source_blob=f.blob,
               outputs=["missing.txt"], write_paths=["missing.txt"])
        f.call("supervisor", "plan.review", id="upr", plan="p", tasks=["t", "u"], outcome="PASS", source_blob=f.blob)
        f.call("pm", "task.admit", id="uad", task="u", review="upr")
        bundle = f.call("pm", "bundle.record", mission="m", target="t", items=[])["bundle"]
        self.assertEqual(["t"], bundle["scope"])
        self.assertFalse(any("missing.txt" in item["path"] for item in bundle["items"]))
        f.call("calibrator", "calibration.record", bundle=bundle["id"], task="t", wave=1, outcome="ALIGNED", source_blob=f.blob)
        refuses(self, "INPUT_INCOMPLETE", lambda: f.call("pm", "bundle.record", mission="m", target="mission-close", items=[]))

    def test_managed_endpoint_acceptance_reads_evidence_and_pm_can_request_history(self):
        from mp_runtime.managed import ManagedBroker
        f = self.f
        self.configure()
        self.construct()
        broker = ManagedBroker(f.engine)
        seat = broker.seat("stabilizer", "m", ["t"])
        packet = broker.packet(seat)
        snapshot = broker.tool(seat, {"tool": "submit", "request": dict(action="acceptance.snapshot", request_id="managed-snapshot", data={"receipt": "wr"})})
        request = dict(action="acceptance.record", request_id="managed-accept", data=dict(receipt="wr", outcome="ACCEPTED",
            basis=snapshot["basis"], source_blob=f.blob, criteria={"o": {"status": "met", "evidence": [self.run["id"]]}}))
        refuses(self, "INPUT_NOT_READ", lambda: broker.tool(seat, {"tool": "submit", "request": request}))
        for blob in packet["input_manifest"]:
            broker.tool(seat, {"tool": "read_blob", "blob": blob})
        broker.tool(seat, {"tool": "submit", "request": request})
        pm = broker.seat("pm", "m")
        compact = broker.packet(pm)
        full = broker.tool(pm, {"tool": "refresh_packet", "full": True})
        self.assertTrue(any("basis" not in r["object"] for r in compact["records"] if r["kind"] == "report"))
        self.assertTrue(any("basis" in r["object"] for r in full["records"] if r["kind"] == "report" and r["object"]["kind"] == "acceptance"))
        self.assertTrue(any(r["kind"] == "schedule" and r["object"]["task"] == "t" for r in full["records"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
