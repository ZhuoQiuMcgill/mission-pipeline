"""From an empty root to a real output and closure through installed CLI verbs."""
import hashlib
import itertools
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from v4_support import ROOT, Fixture, refuses
from mp_runtime.engine import Engine
from mp_runtime.process import RuntimeRefusal, json_bytes
from mp_runtime.review import REVIEW_ACTIONS


class CliFixture(Fixture):
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mp-cli-中文 空格-")
        self.root = Path(self.temp.name)
        self.engine = Engine(self.root)
        self.n = itertools.count()
        self.managed = False
        self.invoke("principal", ["init"])
        source = self.root / "原始授权.txt"
        source.write_text("用户大方向：交付一份可用报告。\n授权 PM 自主选择和修订展示方法，隐私必须保留。\nPrincipal: deliver a usable report; PM may choose and revise the method.\n", encoding="utf-8")
        self.blob = self.invoke("principal", ["blob", "put", str(source)])["blob"]

    def invoke(self, role, args, raw=None):
        result = subprocess.run([sys.executable, str(ROOT / "skills/mission-pipeline/scripts/mp"), "--root", str(self.root), "--actor", role] + args,
                                input=raw, capture_output=True, cwd=ROOT.parent, timeout=40)
        body = json.loads(result.stdout)
        if result.returncode:
            if body.get("ok") is not False:
                raise AssertionError((result.returncode, body))
            raise RuntimeRefusal(body["code"], body["detail"])
        if body.get("ok") is False:
            raise AssertionError("False success exit code")
        return body

    def call(self, role, action, **data):
        if action in ("root.review", "plan.review"):
            kind, field = ("candidate", "candidate") if action == "root.review" else ("plan", "plan")
            mission = self.invoke(role, ["api", "--stdio"], json_bytes({"action": "query", "data": {"kind": kind, "id": data[field]}}))["object"]["mission"]
            data["contract_scope_digest"] = self.invoke(role, ["api", "--stdio"], json_bytes({"action": "contracts.snapshot", "data": {"mission": mission}}))["contract_scope_digest"]
        if action in REVIEW_ACTIONS:
            data = dict(data, **self.invoke(role, ["api", "--stdio"], json_bytes({"action": "review.snapshot", "data": data})))
        return self.invoke(role, ["api", "--stdio"], json_bytes({"action":action, "data":data, "request_id":"cli-" + str(next(self.n))}))


class PublicCliTests(unittest.TestCase):
    def test_authorized_revision_generates_chosen_product_and_closes(self):
        f = CliFixture()
        self.addCleanup(f.close)
        f.setup()
        f.call("pm", "decision.record", id="revised-method", mission="m", grant="g", domain="method", effects={"format":"plain text"},
               choice="plain text report", rationale_blob=f.blob, revises="d")
        path = f.root / "verify.py"
        old = path.read_bytes()
        replacement = old.replace(b"A usable report from controlled product execution", b"A usable report; chosen method: plain text")
        sha = f.engine.store.blobs.put(replacement)
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py", expected_sha256=hashlib.sha256(old).hexdigest(), source_blob=sha)
        # A mandatory false report blocks the old ticket until an independent result.
        case = f.issue()
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        f.accept()
        self.assertIn(b"chosen method: plain text", (f.root / "report.txt").read_bytes())
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        result = f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"], review=review["id"], closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("CLOSED", result["status"])
        self.assertTrue(f.invoke("principal", ["doctor"])["ok"])
        f.invoke("principal", ["rebuild"])
        self.assertEqual("CLOSED", f.invoke("principal", ["query", "root", "m"])["object"]["status"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
