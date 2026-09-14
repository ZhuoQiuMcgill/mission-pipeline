#!/usr/bin/env python3
"""M23 — the 1.2 to 2.1 mid-mission upgrade, end to end (S17).

2.0.0's `legacy.adopt` was an archive marker: an open 1.2 mission had to redo the
entire v4 chain and re-earn every acceptance a stabilizer had already sealed. 2.1
adopts the verified evidence of the legacy mission and lets the PM credit each
recorded ACCEPTED verdict to one current obligation (`legacy.accept`), so the
mission can finish under v4 without re-running work that is already done.

Two runs of the same scenario:
  * the real 421-event field ledger (Week36, six accepted task cells), on a copy;
    skipped with a message when the ignored `data/` directory is absent;
  * a synthetic v3 ledger built here through `mp` under MP_COMPAT_V3=1 — one
    Charter, one TaskSpec, one DevReport, a PASS Critique and an ACCEPTED
    GroupReport — which always runs.

Run: python3 tests/m23_continuity.py
"""
import itertools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from v4_support import ROOT, refuses
from mp_runtime.engine import Engine
from mp_runtime.migration import adoption_plan, migrate
from mp_runtime.storage import RuntimeStore
from mp_runtime.workflow import Actor

FIELD_SOURCE = ROOT / "data/analysis/pm-evidence-expansion-20260909/source/latest/mission-pipeline"
MP = str(ROOT / "skills/mission-pipeline/scripts/mp")
sys.path.insert(0, str(ROOT / "tests/fixtures"))
from docs import write as fixture  # noqa: E402

PRODUCT = (b"import os\nfrom pathlib import Path\n"
           b"p=Path(os.environ['MP_OUTPUT_DIR'])/'report.txt'\n"
           b"p.write_text('A usable report from controlled product execution',encoding='utf-8')\n"
           b"assert p.read_text(encoding='utf-8').startswith('A usable report')\n"
           b"print('PASS actual verification')\n")
TABLE = b"| # | criterion | status | anchor | type |\n|---|---|---|---|---|\n"


class Upgrade:
    """Drive the whole v4 chain over an adopted legacy scope."""

    def __init__(self, engine, mission, legacy_mission):
        self.engine, self.mission, self.legacy = engine, mission, legacy_mission
        self.n = itertools.count()
        self.requests = []

    def call(self, role, action, **data):
        engine = self.engine.with_actor(Actor(role, "seat:" + role))
        if action in ("root.review", "plan.review"):
            kind, field = ("candidate", "candidate") if action == "root.review" else ("plan", "plan")
            mission = engine.object(kind, data[field])["mission"]
            data["contract_scope_digest"] = engine.handle(
                {"action": "contracts.snapshot", "data": {"mission": mission}})["contract_scope_digest"]
        self.requests.append((role, action))
        return engine.handle(dict(action=action, data=data, request_id="upgrade-" + str(next(self.n))))

    def overlays(self):
        return {oid: row["data"] for (kind, oid), row in self.engine.store.read().items()
                if kind == "semantic_overlay"}

    def adopt(self):
        self.call("principal", "project.configure", mode="local")
        inventory = self.engine.object("legacy_inventory", "source")
        charter = next(o for o in inventory["overlays"]
                       if str(o.get("mission")) == str(self.legacy) and o.get("category") == "Charter"
                       and o["status"] == "VERIFIED")
        self.charter_blob = self.engine.store.blobs.put(Path(charter["source_path"]).read_bytes())
        # The Charter the legacy mission actually ran under IS the principal source.
        return self.call("pm", "legacy.adopt", mission=self.mission, legacy_mission=self.legacy,
                         source_blob=self.charter_blob)["scope"]

    def root(self, goal):
        b = self.charter_blob
        self.goal = goal
        self.call("principal", "authority.record", id="a", source_blob=b, goals=[goal], constraints={})
        self.call("principal", "grant.record", id="g", authority="a", source_blob=b, scope=self.mission,
                  domains=["method"], permissions=["choose", "revise", "defer", "close"])
        self.call("pm", "intake.create", id="i", authority="a", mission=self.mission)
        self.call("pm", "root.propose", id="cand", intake="i", source_blob=b, goals=[goal])
        self.call("supervisor", "root.review", id="rr", candidate="cand", outcome="MATCH", source_blob=b)
        return self.call("pm", "root.activate", candidate="cand", review="rr")["root"]

    def carry_over(self, acceptances):
        """One obligation per legacy task cell, met by its recorded acceptance."""
        obligations = [{"id": "o-" + a["task_key"], "goal": self.goal,
                        "description": "legacy task cell " + a["task_key"]} for a in acceptances]
        self.call("pm", "plan.record", id="p-legacy", mission=self.mission, goals=[self.goal],
                  source_blob=self.charter_blob, obligations=obligations)
        met = []
        for a in acceptances:
            met.append(self.call("pm", "legacy.accept", mission=self.mission,
                                 obligation="o-" + a["task_key"], legacy_artifact=a["artifact"])["obligation"])
        return met

    def new_work(self, root):
        b = self.charter_blob
        self.call("pm", "plan.record", id="p", mission=self.mission, goals=[self.goal], source_blob=b,
                  obligations=[dict(id="o-new", goal=self.goal, description="the remaining v4 outcome")])
        self.call("pm", "task.record", id="t", mission=self.mission, obligations=["o-new"], grant="g",
                  domain="method", effects=["write-report"], allowed_effects=["write-report"], inputs=[b],
                  source_blob=b, write_paths=["verify.py"], outputs=["report.txt"])
        self.call("principal", "environment.register", id="env", executable=sys.executable, cwd=str(root))
        self.call("pm", "requirement.record", id="r", task="t", argv=["{python}", "verify.py"],
                  inputs=["verify.py"], environment="env", scope="closing",
                  outputs=[{"path": "report.txt", "destination": "report.txt"}])
        self.call("supervisor", "plan.review", id="pr", plan="p", tasks=["t"], outcome="PASS", source_blob=b)
        self.call("pm", "task.admit", id="ad", task="t", review="pr")
        self.call("constructor", "work.write", task="t", admission="ad", path="verify.py",
                  source_blob=self.engine.store.blobs.put(PRODUCT))
        self.run = self.call("constructor", "run.execute", requirement="r", admission="ad")["run"]
        rows = TABLE + b"| o-new | the remaining v4 outcome | met | controlled output | R |\n"
        put = self.engine.store.blobs.put
        self.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE",
                  source_blob=put(b"# Implementation\n" + rows), criteria={"o-new": "met"})
        critique = self.call("crititor", "report.record", kind="critique", task="t", outcome="PASS",
                             admission="ad", criteria={"o-new": "met"},
                             source_blob=put(b"# Independent critique\nRead the exported report.\n" + rows))["report"]
        self.call("stabilizer", "report.record", kind="acceptance", task="t", outcome="ACCEPTED", admission="ad",
                  criteria={"o-new": "met"}, critique=critique["id"],
                  source_blob=put(b"# Independent acceptance\nChecked goal, critique, run and report.\n" + rows))
        return self.run

    def close(self):
        b = self.charter_blob
        bundle = self.call("pm", "bundle.record", mission=self.mission, target="close", items=[])["bundle"]
        audit = self.call("auditor", "audit.record", bundle=bundle["id"], source_blob=b, findings=[])["audit"]
        review = self.call("supervisor", "close.review", bundle=bundle["id"], outcome="PASS", source_blob=b)["review"]
        result = self.call("pm", "mission.close", mission=self.mission, bundle=bundle["id"], audit=audit["id"],
                           review=review["id"], closing_run=self.run["id"], grant="g", domain="method", source_blob=b)
        return bundle, result


class ContinuityTests(unittest.TestCase):
    def upgrade_to_closed(self, engine, ledger_root, source_root, mission_name, legacy_mission, product_root):
        plan = adoption_plan(ledger_root, source_root)
        migrate(RuntimeStore(ledger_root), plan, Actor("principal", "migration:m23"))
        up = Upgrade(engine, mission_name, legacy_mission)
        scope = up.adopt()
        verified = [o["artifact"] for o in plan["overlays"]
                    if str(o.get("mission")) == str(legacy_mission) and o["status"] == "VERIFIED"]
        self.assertEqual(sorted(str(a) for a in verified), sorted(scope["artifacts"]),
                         "an omitted artifacts list adopts every verified overlay of the legacy mission")
        acceptances = scope["acceptances"]
        self.assertTrue(acceptances, "the legacy mission has at least one sealed ACCEPTED verdict")
        for item in acceptances:
            self.assertEqual(str(legacy_mission), str(item["legacy_mission"]))
            self.assertEqual(mission_name, item["mission_name"])

        up.root(mission_name.lower() + "-goal")
        met = up.carry_over(acceptances)
        for item, source in zip(met, acceptances):
            self.assertEqual("MET", item["status"])
            self.assertEqual("legacy:" + str(source["artifact"]), item["evidence"])
            self.assertEqual("legacy-recorded", item["assurance"])
            self.assertEqual(source["task_key"], item["accepted_task_key"])

        # A second credit of the same artifact is refused; the obligation is spent.
        refuses(self, "STALE_HEAD", lambda: up.call("pm", "legacy.accept", mission=mission_name,
                obligation="o-" + acceptances[0]["task_key"], legacy_artifact=acceptances[0]["artifact"]))
        unavailable = [o["artifact"] for o in plan["overlays"]
                       if str(o.get("mission")) == str(legacy_mission) and o["status"] != "VERIFIED"]
        if unavailable:
            refuses(self, "LEGACY_EVIDENCE_UNAVAILABLE", lambda: up.call(
                "pm", "legacy.accept", mission=mission_name, obligation="o-new", legacy_artifact=unavailable[0]))

        run = up.new_work(product_root)
        self.assertTrue(run["satisfied"])
        self.assertTrue((Path(product_root) / "report.txt").read_bytes().startswith(b"A usable report"))
        bundle, result = up.close()
        self.assertEqual("CLOSED", result["status"])
        blobs = {item["path"]: item["blob"] for item in bundle["items"]}
        overlays = up.overlays()
        for artifact in scope["artifacts"]:
            self.assertEqual(overlays[artifact]["source_blob"], blobs["legacy:" + artifact],
                             "the closure bundle carries the adopted legacy bytes")
        statuses = {o["id"]: o["status"] for o in result["outcomes"]}
        self.assertEqual({"MET"}, set(statuses.values()), statuses)
        self.assertTrue(engine.store.doctor()["ok"])
        return up, scope, result

    @unittest.skipUnless((FIELD_SOURCE / "ledger/events.jsonl").exists(),
                         "ignored field data not present (data/analysis/...): real-ledger upgrade skipped")
    def test_real_week36_upgrades_mid_mission_and_closes(self):
        with tempfile.TemporaryDirectory(prefix="mp-m23-field-") as td:
            temp = Path(td)
            source_root = temp / "legacy"
            ledger = source_root / "mission-pipeline" / "ledger"
            # Never touch the field data in place: the whole ledger tree is copied,
            # minus the v3 projection, which migration rebuilds from the journal.
            shutil.copytree(FIELD_SOURCE, source_root / "mission-pipeline",
                            ignore=shutil.ignore_patterns("mp.db", "*.db-journal"))
            product = temp / "product"
            product.mkdir()
            engine = Engine(product, Actor("pm", "local:pm"), ledger)
            up, scope, result = self.upgrade_to_closed(engine, ledger, source_root,
                                                       "Week36-SPRHDv07CorrespondenceLayer", 3, product)
            self.assertEqual(44, len(scope["artifacts"]))
            self.assertEqual(["T1", "T2", "T3", "T4", "T5", "T6"],
                             sorted(a["task_key"] for a in scope["acceptances"]))
            self.assertEqual(7, len(result["outcomes"]))
            # The 1.2 calibration bridge came across, released, and never halted v4.
            latches = [row["data"] for (kind, _), row in engine.store.read().items() if kind == "latch"]
            self.assertEqual([False], [l["active"] for l in latches])

    def test_synthetic_v3_ledger_adopts_accepts_and_closes(self):
        mission = "Week03-Continuity"
        with tempfile.TemporaryDirectory(prefix="mp-m23-synthetic-") as td:
            root = Path(td)
            self.build_v3_ledger(root, mission)
            ledger = root / ".claude" / "mission-pipeline" / "ledger"
            engine = Engine(root, Actor("pm", "local:pm"))
            self.assertEqual(ledger, engine.store.path)
            up, scope, result = self.upgrade_to_closed(engine, ledger, root, mission, 1, root)
            self.assertEqual(["T1"], [a["task_key"] for a in scope["acceptances"]])
            self.assertEqual(2, len(result["outcomes"]))
            self.assertEqual("legacy-recorded",
                             next(o for o in result["outcomes"] if o["id"] == "o-T1")["assurance"])

    def build_v3_ledger(self, root, mission):
        """A real 1.2 ledger, written by the frozen v3 dispatcher through `mp`."""
        env = dict(os.environ, MP_ROOT=str(root), MP_ACTOR="pm", MP_COMPAT_V3="1")

        def git(*args):
            self.assertEqual(0, subprocess.run(["git", "-C", str(root), *args],
                                               capture_output=True).returncode, args)

        def mp(*args, rc=0):
            p = subprocess.run([sys.executable, MP, "--json", *args], capture_output=True,
                               text=True, encoding="utf-8", env=env)
            self.assertEqual(rc, p.returncode, p.stdout[:400] + p.stderr[:400])
            return json.loads(p.stdout.strip().splitlines()[-1])

        def seal(name, kind, **kw):
            kw.setdefault("mission", mission)
            rel = f".claude/mission-pipeline/ledger/{mission}/{name}"
            fixture(root, rel, kind, **kw)
            return mp("seal", rel)

        git("init", "-q")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "user.name", "fixture")
        (root / "src.txt").write_bytes(b"the toy project\n")
        git("add", "-A")
        git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "init")
        mp("init")
        charter = seal("Charter_v01.md", "charter", version=1, derives="none",
                       extra_header="branch: mission/week03\ncap: 3",
                       goal="the loader reads the environment exactly once",
                       prohibitions="- never widen a test's tolerance to make it pass",
                       amendments="| v1 | 2026-08-31 | (initial seal) | — |")["artifact"]["id"]
        mp("wave", "open", "W1", "--mission", mission, "--tasks", "T1")
        spec = seal("TaskSpec_T1_v01.md", "taskspec", key="T1", version=1, wave="W1", recovers="",
                    touches="no", derives=f"artifact:{charter}",
                    objective="the loader reads the env exactly once",
                    ac1="one read per process",
                    out_of_scope="- the retry path")["artifact"]["id"]
        (root / "suite.log").write_bytes(b"2 suites green\n")
        run = mp("run", "record", "--cmd", "python3 -m pytest -q", "--log", "suite.log", "--tree", ".")["id"]
        dev = seal("DevReport_T1_r1_v01.md", "devreport", key="T1", round=1, version=1,
                   derives=f"artifact:{spec}", summary="one read, memoized",
                   runs=f"| run:{run} | python3 -m pytest -q | 2 suites green |",
                   noticed="- None", relay="")["artifact"]["id"]
        critique = seal("Critique_T1_r1_v01.md", "critique", key="T1", round=1, version=1,
                        derives=f"artifact:{spec}, artifact:{dev}", verdict="PASS",
                        criteria=f"| 1 | one read per process | met | run:{run} | R |",
                        risk="- None", relay="")["artifact"]["id"]
        group = seal("GroupReport_T1_v01.md", "groupreport", key="T1", version=1,
                     derives=f"artifact:{dev}, artifact:{critique}", outcome="ACCEPTED",
                     reasoning="one round, anchored")
        self.assertEqual("ACCEPTED", group["verdicts"][0]["kind"])
        return group["artifact"]["id"]


if __name__ == "__main__":
    unittest.main(verbosity=2)
