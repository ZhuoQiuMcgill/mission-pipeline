"""R3 cross-mission standing authority, scoped packets and legitimate retirement."""
import base64
import json
import os
import subprocess
import sys
import time
import unittest
from v4_support import ROOT, Fixture, refuses
from mp_runtime.managed import ManagedBroker
from mp_runtime.contracts import applicable_contracts


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture(managed=True)
        self.addCleanup(self.f.close)
        self.f.broker = ManagedBroker(self.f.engine)
        self.f.broker.start()
        self.a_seats = {}

    def a_call(self, role, action, **data):
        f = self.f
        request = {"action": action, "request_id": "a-" + str(next(f.n)), "data": data}
        if role == "principal":
            return f.broker.principal(request)
        seat = self.a_seats.setdefault(role, f.broker.seat(role, "A"))
        packet = f.broker.packet(seat)
        for blob in packet["input_manifest"]:
            f.broker.tool(seat, {"tool": "read_blob", "blob": blob})
        return f.broker.tool(seat, {"tool": "submit", "request": request})

    def setup_a(self, scope="project", policy=None):
        f = self.f
        self.a_blob = f.engine.store.blobs.put(b"Principal A: all project report publication must remain private, not only mission A.")
        self.a_call("principal", "authority.record", id="aA", source_blob=self.a_blob, goals=["reportA"],
                    constraints={"privacy": "private"}, constraint_scopes={"privacy": "project" if scope == "project" else "mission"},
                    constraint_policies={"privacy": policy or {}})
        self.a_call("principal", "grant.record", id="gA", authority="aA", source_blob=self.a_blob, scope="A", domains=["method"], permissions=["choose", "revise"])
        self.a_call("pm", "intake.create", id="iA", authority="aA", mission="A")
        self.a_call("pm", "root.propose", id="cA", intake="iA", source_blob=self.a_blob, goals=["reportA"],
                    contracts=[dict(authority="aA", scope=scope if scope == "project" else "A", clause="privacy")])
        review = self.a_call("supervisor", "root.review", candidate="cA", outcome="MATCH", source_blob=self.a_blob)["review"]
        self.a_call("pm", "root.activate", candidate="cA", review=review["id"])
        self.contract = next(v["data"] for (k, _), v in f.engine.store.read().items() if k == "contract")

    def choose(self, privacy, id):
        return self.f.call("pm", "decision.record", id=id, mission="m", grant="g", domain="method",
                           effects={"privacy": privacy}, rationale_blob=self.f.blob, choice=privacy + " report")

    def test_project_contract_is_read_and_enforced_then_explicit_retirement_recovers(self):
        f = self.f
        self.setup_a()
        f.setup(constraints={})
        packet = f.broker.packet(f.broker.seat("supervisor", "m"))
        self.assertIn(self.a_blob, packet["input_manifest"])
        self.assertEqual([self.contract["id"]], [r["object"]["id"] for r in packet["records"] if r["kind"] == "contract"])
        self.assertFalse(any(r["kind"] in ("root", "candidate", "grant") and r["object"].get("id") in ("A", "cA", "gA") for r in packet["records"]))
        refuses(self, "AUTHORITY_CONFLICT", lambda: self.choose("public", "bad"))
        self.choose("private", "private-choice")
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        refuses(self, "CONTRACT_AUTHORITY_REQUIRED", lambda: f.call("principal", "contract.retire", contract=self.contract["id"], authority="a", source_blob=f.blob))
        retirement = f.engine.store.blobs.put(b"Principal A explicitly retires the project privacy condition; publication may now be public.")
        self.a_call("principal", "contract.retire", contract=self.contract["id"], authority="aA", source_blob=retirement)
        self.choose("public", "public-after-retirement")
        f.review_admit()
        f.accept(round=2)
        result = f.call("pm", "consume", admission=f.admission)
        self.assertTrue(result["committed"])
        retired = f.engine.object("contract", self.contract["id"])
        self.assertFalse(retired["active"])
        self.assertEqual(self.a_blob, retired["source_blob"])
        self.assertEqual(retirement, retired["retirement_blob"])
        self.assertEqual("aA", retired["retired_by"])
        print("R3_CONTRACT_RECOVERY " + json.dumps({"contract": retired, "consume": result}, sort_keys=True))

    def test_mission_only_expired_and_nonapplicable_contracts_do_not_expand(self):
        for scope, policy in [("mission", {}), ("project", {"expiry": time.time() - 1}),
                              ("project", {"applicability": {"missions": ["A"]}})]:
            with self.subTest(scope=scope, policy=policy):
                if hasattr(self, "contract"):
                    self.tearDown()
                    self.setUp()
                self.setup_a(scope, policy)
                self.f.setup(constraints={})
                self.choose("public", "allowed-public")
                self.assertEqual([], applicable_contracts(self.f.engine.store.read(), "m"))
                self.f.accept()
                self.f.call("pm", "consume", admission=self.f.admission)

    def test_new_candidate_omission_does_not_retire_project_and_old_match_ticket_stale(self):
        f = self.f
        f.setup(constraints={})
        ticket = f.call("pm", "task.dispatch", admission=f.admission)["ticket"]
        c = f.call("pm", "root.propose", intake="i", revises="c", source_blob=f.blob, goals=["usable-report"])["candidate"]
        review = f.call("supervisor", "root.review", candidate=c["id"], outcome="MATCH", source_blob=f.blob)["review"]
        self.setup_a()
        refuses(self, "STALE_ROOT_REVIEW", lambda: f.call("pm", "root.activate", candidate=c["id"], review=review["id"], revises_root="c"))
        refuses(self, "STALE_ADMISSION", lambda: f.call("constructor", "task.claim", ticket=ticket["id"]))
        c2 = self.a_call("pm", "root.propose", intake="iA", revises="cA", source_blob=self.a_blob, goals=["reportA"], contracts=[])["candidate"]
        r2 = self.a_call("supervisor", "root.review", candidate=c2["id"], outcome="MATCH", source_blob=self.a_blob)["review"]
        self.a_call("pm", "root.activate", candidate=c2["id"], review=r2["id"], revises_root="cA")
        self.assertTrue(f.engine.object("contract", self.contract["id"])["active"])
        r = f.call("supervisor", "root.review", candidate=c["id"], outcome="MATCH", source_blob=f.blob)["review"]
        f.call("pm", "root.activate", candidate=c["id"], review=r["id"], revises_root="c")
        self.choose("private", "still-private")
        f.review_admit()
        f.accept()
        f.call("pm", "consume", admission=f.admission)

    def test_existing_decision_must_be_corrected_and_principal_policy_cannot_be_narrowed_by_pm(self):
        f = self.f
        f.setup(constraints={})
        self.choose("public", "old-public")
        self.setup_a()
        refuses(self, "AUTHORITY_CONFLICT", lambda: f.review_admit())
        f.call("pm", "decision.record", id="corrected", mission="m", grant="g", domain="method",
               effects={"privacy": "private"}, rationale_blob=f.blob, choice="private correction", revises="old-public")
        f.review_admit()
        f.accept()
        f.call("pm", "consume", admission=f.admission)
        # A new candidate cannot smuggle an expiry or change applicability.
        c = self.a_call("pm", "root.propose", intake="iA", revises="cA", source_blob=self.a_blob, goals=["reportA"],
                        contracts=[dict(authority="aA", scope="project", clause="privacy", expiry=time.time() - 1)])["candidate"]
        refuses(self, "CONTRACT_AUTHORITY_REQUIRED", lambda: self.a_call("supervisor", "root.review", candidate=c["id"], outcome="MATCH", source_blob=self.a_blob))
        for policy in ({"expiry": "tomorrow"}, {"applicability": "only whenever PM wants"}, {"active": False}):
            refuses(self, "INVALID_CONTRACT_POLICY", lambda: self.a_call("principal", "authority.record", source_blob=self.a_blob,
                    constraints={"privacy": "private"}, constraint_policies={"privacy": policy}))

    def test_legacy_project_contract_text_survives_migration_and_cross_mission_reading(self):
        from mp_runtime.migration import adoption_plan, migrate
        from mp_runtime.storage import RuntimeStore
        from mp_runtime.workflow import Actor
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as td:
            ledger = Path(td)
            event = {"seq": 1, "at": "2026-09-09T00:00:00Z", "actor": "principal", "action": "contract.add", "result": "OK", "payload": {
                "id": 7, "text": "Never silently omit an original recorded condition.", "origin": "old charter", "verified_by": "crititor", "ratified_at": "old"}}
            raw = (json.dumps(event) + "\n").encode()
            (ledger / "events.jsonl").write_bytes(raw)
            store = RuntimeStore(ledger)
            plan = adoption_plan(ledger)
            migrate(store, plan, Actor("principal", "test-migration"))
            contracts = applicable_contracts(store.read(), "new-mission")
            self.assertEqual("legacy_project", contracts[0]["scope"])
            self.assertTrue(contracts[0]["active"])
            self.assertEqual(raw, store.blobs.get(contracts[0]["source_blob"]))


if __name__ == "__main__":
    if os.name == "nt":
        root = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:]
        raise SystemExit(subprocess.run(["wsl", "-d", "Ubuntu", "--cd", root, "--exec", "/usr/bin/python3", "tests/m19_contract_scope.py"]).returncode)
    unittest.main(verbosity=2)
