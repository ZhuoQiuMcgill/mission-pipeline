"""Isolated, real v4 fixtures shared by the acceptance suites."""
import itertools
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills/mission-pipeline/scripts"))
from mp_runtime.engine import Engine
from mp_runtime.workflow import Actor
from mp_runtime.process import RuntimeRefusal
from mp_runtime.review import REVIEW_ACTIONS


class Fixture:
    def __init__(self, managed=False):
        self.temp = tempfile.TemporaryDirectory(prefix="mp-v4-空 格-")
        self.root = Path(self.temp.name)
        self.engine = Engine(self.root)
        self.engine.store.initialize()
        self.n = itertools.count()
        self.managed = managed
        self.blob = self.engine.store.blobs.put(b"Principal: deliver a usable report; PM may choose and revise the method.")
        self.call("principal", "project.configure", mode="local")

    def close(self):
        self.temp.cleanup()

    def call(self, role, action, **data):
        if getattr(self, "broker", None):
            request = dict(action=action, data=data, request_id="req-" + str(next(self.n)))
            if role == "principal":
                return self.broker.principal(request)
            self.seats = getattr(self, "seats", {})
            if role not in self.seats:
                self.seats[role] = self.broker.seat(role, "m")
            seat = self.seats[role]
            packet = self.broker.packet(seat)
            for blob in packet["input_manifest"]:
                if blob not in seat["read_blobs"]:
                    self.broker.tool(seat, {"tool": "read_blob", "blob": blob})
            return self.broker.tool(seat, {"tool": "submit", "request": request})
        engine = self.engine.with_actor(Actor(role, "seat:" + role, self.managed))
        if action in ("root.review", "plan.review"):
            kind, field = ("candidate", "candidate") if action == "root.review" else ("plan", "plan")
            mission = engine.object(kind, data[field])["mission"]
            data["contract_scope_digest"] = engine.handle({"action": "contracts.snapshot", "data": {"mission": mission}})["contract_scope_digest"]
        if action in REVIEW_ACTIONS:
            data = dict(data, **engine.handle({"action": "review.snapshot", "data": data}))
        return engine.handle(dict(action=action, data=data, request_id="req-" + str(next(self.n))))

    def setup(self, constraints=None):
        b = self.blob
        self.call("principal", "authority.record", id="a", source_blob=b, goals=["usable-report"], constraints=constraints if constraints is not None else {"privacy": "private"})
        self.call("principal", "grant.record", id="g", authority="a", source_blob=b, scope="m",
                  domains=["method"], permissions=["choose", "revise", "defer", "close"])
        self.call("pm", "intake.create", id="i", authority="a", mission="m")
        self.call("pm", "root.propose", id="c", intake="i", source_blob=b, goals=["usable-report"])
        self.call("supervisor", "root.review", id="rr", candidate="c", outcome="MATCH", source_blob=b)
        self.call("pm", "root.activate", candidate="c", review="rr")
        self.call("pm", "decision.record", id="d", mission="m", grant="g", domain="method", effects={"format": "html"}, rationale_blob=b, choice="interactive report")
        self.call("pm", "plan.record", id="p", mission="m", goals=["usable-report"], source_blob=b,
                  obligations=[dict(id="o", goal="usable-report", description="actual usable report")])
        self.call("pm", "task.record", id="t", mission="m", obligations=["o"], grant="g", domain="method",
                  effects=["write-report"], allowed_effects=["write-report"], inputs=[b], source_blob=b,
                  write_paths=["verify.py"], outputs=["report.txt"])
        self.call("principal", "environment.register", id="env", executable=sys.executable, cwd=str(self.root))
        self.call("pm", "requirement.record", id="r", task="t", argv=["{python}", "verify.py"], inputs=["verify.py"], environment="env", scope="closing", outputs=[{"path": "report.txt", "destination": "report.txt"}])
        self.review_admit()
        source = b"import os\nfrom pathlib import Path\np=Path(os.environ['MP_OUTPUT_DIR'])/'report.txt'\np.write_text('A usable report from controlled product execution',encoding='utf-8')\nassert p.read_text(encoding='utf-8').startswith('A usable report')\nprint('PASS actual verification')\n"
        if getattr(self, "broker", None):
            import base64
            seat = self.broker.seat("constructor", "m", ["t"])
            packet = self.broker.packet(seat)
            for blob in packet["input_manifest"]:
                self.broker.tool(seat, {"tool": "read_blob", "blob": blob})
            sha = self.broker.tool(seat, {"tool": "submit_blob", "base64": base64.b64encode(source).decode("ascii")})["blob"]
            self.broker.tool(seat, {"tool": "submit", "request": dict(action="work.write", request_id="write-product", data=dict(task="t", admission=self.admission, path="verify.py", source_blob=sha))})
        else:
            sha = self.engine.store.blobs.put(source)
            self.call("constructor", "work.write", task="t", admission=self.admission, path="verify.py", source_blob=sha)

    def review_admit(self, permit=None):
        rid = "pr-" + str(next(self.n))
        aid = "ad-" + str(next(self.n))
        self.call("supervisor", "plan.review", id=rid, plan="p", tasks=["t"], outcome="PASS", source_blob=self.blob)
        self.call("pm", "task.admit", id=aid, task="t", review=rid, permit=permit)
        self.admission = aid

    def accept(self, round=1, calibrate=True):
        prior = {row["data"]["kind"]: row["data"]["id"] for (kind, _), row in self.engine.store.read().items()
                 if kind == "report" and row["data"].get("current") and row["data"].get("task") == "t"}
        def revision(kind):
            return dict(round=round, revises=prior.get(kind)) if round > 1 else {}
        self.run = self.call("constructor", "run.execute", requirement="r", admission=self.admission)["run"]
        def source(role, raw):
            if getattr(self, "broker", None):
                import base64
                self.seats = getattr(self, "seats", {})
                if role not in self.seats:
                    self.seats[role] = self.broker.seat(role, "m")
                seat = self.seats[role]
                packet = self.broker.packet(seat)
                delivery = next(row["object"] for row in packet["records"] if row["kind"] == "delivery" and row["object"].get("current") and row["object"]["path"] == "report.txt")
                actual = self.broker.tool(seat, {"tool": "read_blob", "blob": delivery["source_blob"]})
                assert base64.b64decode(actual["base64"]).startswith(b"A usable report")
                return self.broker.tool(seat, {"tool": "submit_blob", "base64": base64.b64encode(raw).decode("ascii")})["blob"]
            assert (self.root / "report.txt").read_bytes().startswith(b"A usable report")
            return self.engine.store.blobs.put(raw)
        table = b"| # | criterion | status | anchor | type |\n|---|---|---|---|---|\n| o | actual usable report | met | controlled output | R |\n"
        result = self.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=source("constructor", b"# Implementation\n" + table), criteria={"o": "met"}, **revision("development"))
        critique = self.call("crititor", "report.record", kind="critique", task="t", outcome="PASS", admission=self.admission,
                             source_blob=source("crititor", b"# Independent critique\nRead and checked actual exported report.\n" + table), criteria={"o": "met"}, **revision("critique"))["report"]
        task = self.engine.object("task", "t")
        if calibrate and (task.get("calibration_required") or self.engine.object("admission", self.admission).get("permit") or round == 3):
            bundle = self.call("pm", "bundle.record", mission="m", target="t", items=[])["bundle"]
            self.call("calibrator", "calibration.record", bundle=bundle["id"], task="t", wave=1, outcome="ALIGNED", source_blob=self.blob)
        return self.call("stabilizer", "report.record", kind="acceptance", task="t", outcome="ACCEPTED", admission=self.admission,
                         source_blob=source("stabilizer", b"# Independent acceptance\nChecked original goal, critique, run and actual exported report.\n" + table), criteria={"o": "met"}, critique=critique["id"], **revision("acceptance"))

    def issue(self, role="auditor", **changes):
        data = dict(kind="MANDATORY_COUNTEREXAMPLE", mission="m", source_blob=self.blob,
                    counterexample_blob=self.blob, target="t", tasks=["t"], obligations=["o"])
        data.update(changes)
        return self.call(role, "issue.report", **data)["case"]


def refuses(test, code, fn):
    with test.assertRaises(RuntimeRefusal) as cm:
        fn()
    test.assertEqual(code, cm.exception.code)
