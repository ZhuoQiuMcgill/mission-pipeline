"""Rejected released transactions remain history without becoming current credit."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import m23_continuity as continuity
from mp_runtime.engine import Engine
from mp_runtime.migration import adoption_plan, migrate
from mp_runtime.workflow import Actor


class QualifiedMigration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mp-m26-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifact = continuity.ContinuityTests().build_v3_ledger(self.root, "Week03-Continuity")
        self.ledger = self.root / ".claude/mission-pipeline/ledger"
        self.journal = self.ledger / "events.jsonl"

    def events(self):
        return [json.loads(line) for line in self.journal.read_bytes().splitlines()]

    def write(self, events):
        self.journal.write_bytes(b"".join((json.dumps(e) + "\n").encode("utf-8") for e in events))

    def test_rolled_back_group_report_cannot_create_acceptance_or_contract_credit(self):
        events = self.events()
        sealed = next(e for e in events if e["action"] == "artifact.sealed" and e["payload"]["artifact"]["id"] == self.artifact)
        sealed["payload"]["edges"].append({"from": self.artifact, "to": 999999, "kind": "cites"})
        contract = next(copy.deepcopy(c) for e in events for c in e.get("payload", {}).get("contracts", []))
        contract["id"] = 55555
        sealed["payload"].setdefault("contracts", []).append(contract)
        self.write(events)
        original = self.journal.read_bytes()
        plan = adoption_plan(self.ledger, self.root)
        self.assertEqual(original, self.journal.read_bytes())
        self.assertEqual(hashlib.sha256(original).hexdigest(), plan["journal_sha256"])
        self.assertEqual(len(events), plan["source_seq"])
        self.assertIn(sealed["seq"], [r["seq"] for r in plan["replay_skipped"]])
        self.assertFalse(any(a["artifact"] == self.artifact for a in plan["acceptances"]))
        self.assertFalse(any(o["artifact"] == self.artifact for o in plan["overlays"]))
        self.assertFalse(any(c["id"] == 55555 for c in plan["contracts"]))
        engine = Engine(self.root, Actor("pm", "migration-test"))
        result = migrate(engine.store, plan, engine.actor)
        self.assertEqual(len(plan["replay_skipped"]), result["replay_skipped"])
        self.assertNotIn(("semantic_overlay", str(self.artifact)), engine.store.read())
        self.assertEqual([], engine.object("legacy_inventory", "source")["acceptances"])
        self.assertEqual(original, self.journal.read_bytes())
        self.assertTrue(engine.store.doctor()["ok"])

    def test_released_close_payload_preserves_closed_state(self):
        events = self.events()
        plan = adoption_plan(self.ledger, self.root)
        mission = next(mid for mid, row in plan["missions"].items() if row.get("name") == "Week03-Continuity")
        events.append(dict(seq=len(events) + 1, action="mission.close", actor="pm", result="OK", at="2026-09-30T12:00:00Z",
                           payload=dict(id=mission, name="Week03-Continuity", closed_at="2026-09-30T12:00:00Z")))
        self.write(events)
        self.assertEqual("closed", adoption_plan(self.ledger, self.root)["missions"][mission]["status"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
