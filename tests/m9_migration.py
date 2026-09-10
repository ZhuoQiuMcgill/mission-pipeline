import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from v4_support import ROOT, Fixture, refuses
from mp_runtime.migration import adoption_plan, migrate, calibration_bridge, read_legacy, rollback
from mp_runtime.storage import RuntimeStore
from mp_runtime.workflow import Actor


class MigrationTests(unittest.TestCase):
    def test_real_421_history_and_rebuild(self):
        oracle = json.loads((ROOT / "data/analysis/engine-repair-20260909/legacy-oracle.json").read_text(encoding="utf-8"))
        source = ROOT / "data/analysis/pm-evidence-expansion-20260909/source/latest/mission-pipeline/ledger/events.jsonl"
        raw, events = read_legacy(source)
        self.assertEqual(oracle["source_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(421, len(events))
        self.assertFalse(calibration_bridge(events[:381])["latches"])
        before = calibration_bridge(events[:391])["latches"]
        self.assertEqual([40, 52], before[-1]["triggers"])
        self.assertTrue(before[-1]["active"])
        after = calibration_bridge(events)["latches"]
        self.assertFalse(after[-1]["active"])
        self.assertEqual(392, after[-1]["release"])
        import copy
        forged = copy.deepcopy(events)
        forged[391]["payload"]["by"] = "pm"
        self.assertTrue(calibration_bridge(forged)["latches"][-1]["active"])
        future = copy.deepcopy(events[-4])
        future.update(seq=422, action="artifact.sealed", result="OK", payload={"artifact": {"id": 140, "mission": 3, "key": "W4"}, "verdicts": [{"id": 58, "kind": "DRIFT"}]})
        future_latches = calibration_bridge(events + [future])["latches"]
        self.assertFalse(future_latches[0]["active"])
        self.assertTrue(future_latches[-1]["active"])
        with tempfile.TemporaryDirectory(prefix="mp-migrate-") as td:
            ledger = Path(td)
            (ledger / "events.jsonl").write_bytes(raw)
            store = RuntimeStore(ledger)
            plan = adoption_plan(ledger, source.parents[2])
            self.assertEqual("open", plan["missions"][3]["status"])
            self.assertEqual("closed", plan["missions"][1]["status"])
            overlay = next(row for row in plan["overlays"] if row["artifact"] == 124)
            self.assertEqual("VERIFIED", overlay["status"])
            ac4 = overlay["fields"]["criteria"]["criteria"]["4"]
            self.assertEqual(["met"] * 6 + ["partial"], [row["met"] for row in ac4["rows"]])
            self.assertEqual("partial", ac4["met"])
            migrate(store, plan, Actor("principal", "migration:test"))
            from mp_runtime.contracts import applicable_contracts
            inherited = applicable_contracts(store.read(), "a-new-mission")
            self.assertGreater(len(inherited), 0)
            for contract in inherited:
                self.assertEqual("legacy_project", contract["scope"])
                self.assertEqual(raw.splitlines(keepends=True)[contract["source_event"] - 1], store.blobs.get(contract["source_blob"]))
            self.assertEqual("READY", store.owner()["state"])
            for _ in range(2):
                conn = sqlite3.connect(store.db_path)
                try:
                    self.assertEqual(421, conn.execute("SELECT count(*) FROM events").fetchone()[0])
                    self.assertEqual(139, conn.execute("SELECT count(*) FROM artifacts").fetchone()[0])
                    self.assertEqual("open", conn.execute("SELECT status FROM missions WHERE id=3").fetchone()[0])
                finally:
                    conn.close()
                store.rebuild()
            self.assertEqual(raw, (ledger / "events.jsonl").read_bytes())
            self.assertTrue(store.doctor()["ok"])
            store.db_path.unlink()
            refuses(self, "PROJECTION_MISSING", lambda: store.initialize())
            store.maintenance("recover")
            self.assertTrue(store.doctor()["ok"])
            conn = sqlite3.connect(store.db_path)
            try:
                self.assertEqual(139, conn.execute("SELECT count(*) FROM artifacts").fetchone()[0])
            finally:
                conn.close()
            result = rollback(store)
            self.assertEqual(3, result["schema"])
            self.assertFalse(store.owner_path.exists())
            self.assertTrue((ledger / "retired-v4/runtime-manifest.json").exists())
            self.assertEqual(raw, (ledger / "events.jsonl").read_bytes())

    def test_bootstrap_crash_has_finite_recovery(self):
        for checkpoint in ("bootstrap_owner", "bootstrap_manifest", "bootstrap_database"):
            with self.subTest(checkpoint=checkpoint), tempfile.TemporaryDirectory(prefix="mp-bootstrap-") as td:
                store = RuntimeStore(Path(td) / "ledger")
                def fail(name):
                    if name == checkpoint:
                        raise OSError("simulated process death")
                store.fault = fail
                with self.assertRaises(OSError):
                    store.initialize()
                refuses(self, "BOOTSTRAP_INCOMPLETE", lambda: store.initialize())
                store.fault = None
                store.maintenance("recover")
                self.assertTrue(store.doctor()["ok"])
                self.assertEqual("READY", store.owner()["state"])

    def test_missing_manifest_projection_and_prepared_owner_never_reset_history(self):
        f = Fixture()
        self.addCleanup(f.close)
        f.setup()
        before = f.engine.store.events()
        f.engine.store.manifest_path.unlink()
        f.engine.store.maintenance("recover")
        self.assertEqual(before, f.engine.store.events())
        self.assertEqual("c", f.engine.object("root", "m")["candidate"])
        f.engine.store.db_path.unlink()
        f.engine.store.maintenance("recover")
        self.assertEqual(before, f.engine.store.events())
        self.assertTrue(f.engine.store.doctor()["ok"])
        with tempfile.TemporaryDirectory(prefix="mp-prepared-owner-") as td:
            store = RuntimeStore(Path(td) / "ledger")
            store.fault = lambda name: (_ for _ in ()).throw(OSError("crash")) if name == "bootstrap_prepared" else None
            with self.assertRaises(OSError):
                store.initialize()
            self.assertFalse(store.owner_path.exists())
            store.fault = None
            store.initialize()
            self.assertTrue(store.doctor()["ok"])

    def test_adoption_crashes_restore_bridge_before_ready_and_retry_once(self):
        source = ROOT / "data/analysis/pm-evidence-expansion-20260909/source/latest/mission-pipeline/ledger/events.jsonl"
        for phase in ("bootstrap_prepared", "bootstrap_owner", "bootstrap_manifest", "bootstrap_database"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix="mp-adoption-fault-") as td:
                store = RuntimeStore(Path(td))
                (store.path / "events.jsonl").write_bytes(source.read_bytes())
                plan = adoption_plan(store.path, source.parents[2])
                actor = Actor("principal", "migration-recovery")
                store.fault = lambda name: (_ for _ in ()).throw(OSError("crash")) if name == phase else None
                with self.assertRaises(OSError):
                    migrate(store, plan, actor)
                store.fault = None
                migrate(store, plan, actor)
                again = migrate(store, plan, actor)
                self.assertTrue(again["reused"])
                self.assertEqual(1, len(store.events()))
                self.assertEqual("READY", store.owner()["state"])
                state = store.read()
                self.assertEqual(421, state[("readiness", "legacy")]["data"]["source_seq"])
                latches = [row["data"] for (kind, _), row in state.items() if kind == "legacy_latch"]
                self.assertFalse(latches[-1]["active"])
                self.assertEqual(392, latches[-1]["release"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
