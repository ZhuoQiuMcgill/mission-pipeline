"""Paired governance paths through real private endpoints and restricted execution."""
import os
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
from v4_support import ROOT, Fixture, refuses
from m8_runtime import RuntimeTests
from mp_runtime.managed import ManagedBroker


class ManagedRecoveryTests(RuntimeTests):
    def setUp(self):
        self.f = Fixture(managed=True)
        self.addCleanup(self.f.close)
        self.f.broker = ManagedBroker(self.f.engine)
        self.f.broker.start()

    def close_mission(self):
        f = self.f
        bundle = f.call("pm", "bundle.record", mission="m", target="close", items=[])["bundle"]
        audit = f.call("auditor", "audit.record", bundle=bundle["id"], source_blob=f.blob, findings=[])["audit"]
        review = f.call("supervisor", "close.review", bundle=bundle["id"], source_blob=f.blob, outcome="PASS")["review"]
        result = f.call("pm", "mission.close", mission="m", bundle=bundle["id"], audit=audit["id"], review=review["id"],
                        closing_run=f.run["id"], grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("CLOSED", result["status"])

    def test_recovery_verified_keeps_original_history(self):
        super().test_recovery_verified_keeps_original_history()
        self.close_mission()

    def test_pending_barrier_and_automatic_independent_contest(self):
        super().test_pending_barrier_and_automatic_independent_contest()
        self.f.accept()
        self.close_mission()

    def test_late_auditor_dismissal_and_unique_contest(self):
        f = self.f
        f.setup()
        case = f.issue(role="constructor")
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        same = f.issue(role="auditor")
        self.assertEqual(case["id"], same["id"])
        self.assertEqual("PENDING", f.engine.object("contest", case["id"])["status"])
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        again = f.call("pm", "case.contest", case=case["id"])
        self.assertEqual(case["id"], again["contest"]["case"])
        self.assertEqual(1, len([1 for k, _ in f.engine.store.read() if k == "contest"]))
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        f.accept()
        self.close_mission()

    def test_upheld_issue_then_same_instance_repair_to_close(self):
        f = self.f
        f.setup()
        case = f.issue()
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="UPHOLD", source_blob=f.blob)
        permit = f.call("pm", "recovery.permit", case=case["id"], tasks=["t"])["permit"]
        f.review_admit(permit["id"])
        f.accept()
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="REPAIR_VERIFIED", source_blob=f.blob,
               repair_tasks=["t"], counterexample_eliminated=True)
        self.assertTrue(f.engine.object("case", case["id"])["established"])
        f.review_admit()
        self.close_mission()

    def test_delegated_gap_and_independent_exception_to_close(self):
        f = self.f
        f.setup()
        f.accept()
        # An explicitly recorded remaining obligation is not silently marked fixed.
        f.call("pm", "plan.record", id="gap-plan", mission="m", goals=["usable-report"], source_blob=f.blob,
               obligations=[dict(id="optional-gap", goal="usable-report", description="deferred optional format")])
        f.call("principal", "grant.record", id="no-defer", authority="a", source_blob=f.blob, scope="m", domains=["method"], permissions=["choose"])
        refuses(self, "AUTHORITY_CONFLICT", lambda: f.call("pm", "obligation.defer", obligation="optional-gap", grant="no-defer", domain="method", owner="pm", reason_blob=f.blob))
        f.call("pm", "obligation.defer", obligation="optional-gap", grant="g", domain="method", owner="pm", reason_blob=f.blob)
        case = f.issue(target="optional-gap", tasks=[], obligations=["optional-gap"])
        f.call("supervisor", "issue.screen", case=case["id"], outcome="ESTABLISHED", source_blob=f.blob)
        proposal = f.call("supervisor", "case.resolve", case=case["id"], outcome="AUTHORIZED_EXCEPTION", grant="g", domain="method", source_blob=f.blob)
        self.assertEqual("PENDING", proposal["contest"]["status"])
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="AUTHORIZED_EXCEPTION_VERIFIED", grant="g", domain="method", source_blob=f.blob)
        gap = f.engine.object("obligation", "optional-gap")
        self.assertEqual("AUTHORIZED_DEFERRED", gap["status"])
        self.assertFalse(gap["verified_fixed"])
        self.close_mission()

    def test_pre_active_correction_never_activates_wrong_contract(self):
        f = self.f
        f.call("principal", "authority.record", id="a", source_blob=f.blob, goals=["usable-report"], constraints={"privacy": "private"})
        f.call("principal", "grant.record", id="g", authority="a", source_blob=f.blob, scope="m", domains=["method"], permissions=["choose", "revise"])
        f.call("pm", "intake.create", id="i", authority="a", mission="m")
        f.call("pm", "root.propose", id="bad", intake="i", source_blob=f.blob, goals=["wrong"])
        f.call("supervisor", "root.review", id="bad-review", candidate="bad", outcome="MISMATCH", source_blob=f.blob)
        case = f.issue(target="bad", tasks=[], obligations=[], authority_span={"authority": "a", "quote": "deliver a usable report"})
        f.call("supervisor", "issue.screen", case=case["id"], outcome="ESTABLISHED", source_blob=f.blob)
        f.call("pm", "root.propose", id="correct", intake="i", revises="bad", source_blob=f.blob, goals=["usable-report"])
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "root.activate", candidate="correct", review="bad-review"))
        f.call("supervisor", "root.review", id="correct-review", candidate="correct", outcome="MATCH", source_blob=f.blob)
        f.call("supervisor", "review.rebase", case=case["id"])
        proposal = f.call("supervisor", "case.resolve", case=case["id"], outcome="VERIFIED_FIXED", candidate="correct", counterexample_eliminated=True, source_blob=f.blob)
        self.assertEqual("PENDING", proposal["contest"]["status"])
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="REPAIR_VERIFIED", candidate="correct", counterexample_eliminated=True, source_blob=f.blob)
        f.call("pm", "root.activate", candidate="correct", review="correct-review")
        self.assertEqual("correct", f.engine.object("root", "m")["candidate"])
        self.assertFalse(any(k == "contract" for k, _ in f.engine.store.read()))

    def test_git_identity_reads_do_not_execute_host_hooks_or_filters(self):
        f = self.f
        f.setup()
        from mp_runtime.process import run_bytes
        with tempfile.TemporaryDirectory(prefix="mp-host-git-sentinel-") as td:
            marker = Path(td) / "marker"
            def git(*args):
                result = run_bytes(["git", *args], cwd=f.root)
                self.assertEqual(0, result.returncode, result.stderr)
            git("init", "-q")
            (f.root / ".gitattributes").write_text("verify.py filter=untrusted\n", encoding="utf-8")
            git("add", "verify.py", ".gitattributes")
            git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "source identity")
            script = Path(td) / "host-hook.sh"
            script.write_text("#!/bin/sh\nprintf touched > '" + str(marker) + "'\ncat\n", encoding="utf-8")
            script.chmod(0o755)
            git("config", "core.fsmonitor", str(script))
            git("config", "filter.untrusted.clean", str(script))
            git("config", "filter.untrusted.required", "true")
            # Change tracked bytes so status would otherwise invoke the clean filter.
            import hashlib, base64
            old = (f.root / "verify.py").read_bytes()
            seat = f.broker.seat("constructor", "m", ["t"])
            f.seats["constructor"] = seat
            blob = f.broker.tool(seat, {"tool": "submit_blob", "base64": base64.b64encode(old + b"# changed input\n").decode("ascii")})["blob"]
            f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py", source_blob=blob, expected_sha256=hashlib.sha256(old).hexdigest())
            from unittest.mock import patch
            overrides = {"GIT_CONFIG_COUNT": "3", "GIT_CONFIG_KEY_0": "core.fsmonitor", "GIT_CONFIG_VALUE_0": str(script),
                         "GIT_CONFIG_KEY_1": "filter.untrusted.clean", "GIT_CONFIG_VALUE_1": str(script),
                         "GIT_CONFIG_KEY_2": "core.hooksPath", "GIT_CONFIG_VALUE_2": td, "GIT_DIR": str(Path(td) / "wrong-repository")}
            with patch.dict(os.environ, overrides):
                f.accept()
                self.assertFalse(marker.exists())
                self.assertTrue(f.run["satisfied"])
                self.close_mission()

    def test_actual_image_bundle_missing_cas_and_restored_calibration(self):
        f = self.f
        f.setup()
        import base64, hashlib
        from mp_runtime.storage import digest
        image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=")
        task = f.engine.object("task", "t")
        f.call("pm", "task.record", **dict(task, revises=digest(task), outputs=["report.txt", "chart.png"]))
        f.call("pm", "requirement.record", id="figure", task="t", argv=["{python}", "verify.py"], inputs=["verify.py"], environment="env", outputs=[{"path": "chart.png", "destination": "chart.png"}])
        f.review_admit()
        previous = (f.root / "verify.py").read_bytes()
        source = previous + b"\nimport base64\nPath(os.environ['MP_OUTPUT_DIR'],'chart.png').write_bytes(base64.b64decode(" + repr(base64.b64encode(image)).encode() + b"))\n"
        seat = f.broker.seat("constructor", "m", ["t"])
        f.seats["constructor"] = seat
        blob = f.broker.tool(seat, {"tool": "submit_blob", "base64": base64.b64encode(source).decode()})["blob"]
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py", source_blob=blob, expected_sha256=hashlib.sha256(previous).hexdigest())
        self.assertTrue(f.call("constructor", "run.execute", requirement="figure", admission=f.admission)["run"]["satisfied"])
        f.accept()
        self.assertEqual(image, (f.root / "chart.png").read_bytes())
        bundle = f.call("pm", "bundle.record", mission="m", target="wave-1", items=[])["bundle"]
        image_sha = hashlib.sha256(image).hexdigest()
        self.assertIn(image_sha, [item["blob"] for item in bundle["items"]])
        calibrator = f.broker.seat("calibrator", "m")
        f.seats["calibrator"] = calibrator
        f.broker.packet(calibrator)
        actual = f.broker.tool(calibrator, {"tool": "read_blob", "blob": image_sha})
        self.assertEqual(image, base64.b64decode(actual["base64"]))
        blob_path = f.engine.store.blobs.root / image_sha[:2] / image_sha[2:]
        blob_path.unlink()  # This fixture's generated CAS object only.
        pm = f.seats["pm"]
        missing = f.broker.tool(pm, {"tool": "submit", "request": {"action": "bundle.record", "request_id": "missing-image-bundle", "data": {"mission": "m", "target": "wave-1", "items": []}}})["bundle"]
        self.assertEqual("INPUT_INCOMPLETE", missing["status"])
        for sha in f.broker.packet(calibrator)["input_manifest"]:
            if sha != image_sha:
                f.broker.tool(calibrator, {"tool": "read_blob", "blob": sha})
        request = {"action": "calibration.record", "request_id": "reject-incomplete-image", "data": {"bundle": missing["id"], "wave": 1, "outcome": "ALIGNED", "source_blob": f.blob}}
        refuses(self, "INPUT_INCOMPLETE", lambda: f.broker.tool(calibrator, {"tool": "submit", "request": request}))
        self.assertEqual(image_sha, f.engine.store.blobs.put(image))
        restored = f.call("pm", "bundle.record", mission="m", target="wave-1", items=[])["bundle"]
        f.call("calibrator", "calibration.record", bundle=restored["id"], wave=1, outcome="ALIGNED", source_blob=f.blob)
        self.close_mission()

    def test_delegated_fact_correction_and_dedup_reach_actual_close(self):
        f = self.f
        f.blob = f.engine.store.blobs.put(b"Principal: deliver a usable report preserving all 79 primary and 29 secondary entries. PM may correct prose counts and choose dedup presentation; private data stays private.\n")
        f.setup(constraints={"privacy": "private", "required_primary": 79, "required_secondary": 29})
        f.call("pm", "decision.record", mission="m", grant="g", domain="method", choice="correct stale 78/28 prose to actual 79/29 enumeration", effects={"prose_primary": 79, "prose_secondary": 29}, rationale_blob=f.blob, revises="d", id="correct-counts")
        refuses(self, "AUTHORITY_CONFLICT", lambda: f.call("pm", "decision.record", mission="m", grant="g", domain="method", choice="delete one item to fit stale prose", effects={"required_primary": 78}, rationale_blob=f.blob))
        f.call("principal", "grant.record", id="typos-only", authority="a", source_blob=f.blob, scope="m", domains=["typography"], permissions=["choose", "revise"])
        refuses(self, "AUTHORITY_CONFLICT", lambda: f.call("pm", "decision.record", mission="m", grant="typos-only", domain="method", choice="deduplicate 3 to 2", effects={"dedup_count": 2}, rationale_blob=f.blob))
        f.call("pm", "decision.record", mission="m", grant="g", domain="method", choice="deduplicate repeated presentation rows from 3 to 2", effects={"dedup_count": 2}, rationale_blob=f.blob, revises="correct-counts")
        f.review_admit()
        source = b"import os,json\nfrom pathlib import Path\nprimary=list(range(79));secondary=list(range(29));dedup=list(dict.fromkeys(['a','b','a']))\nassert (len(primary),len(secondary),len(dedup))==(79,29,2)\nPath(os.environ['MP_OUTPUT_DIR'],'report.txt').write_text('A usable report '+json.dumps({'primary':primary,'secondary':secondary,'dedup':dedup}),encoding='utf-8')\nprint('PASS full enumeration and delegated dedup')\n"
        import base64
        seat = f.broker.seat("constructor", "m", ["t"])
        f.seats["constructor"] = seat
        blob = f.broker.tool(seat, {"tool": "submit_blob", "base64": base64.b64encode(source).decode("ascii")})["blob"]
        import hashlib
        f.call("constructor", "work.write", task="t", admission=f.admission, path="verify.py", source_blob=blob, expected_sha256=hashlib.sha256((f.root / "verify.py").read_bytes()).hexdigest())
        f.accept()
        actual = json.loads((f.root / "report.txt").read_text()[len("A usable report "):])
        self.assertEqual((79, 29, 2), (len(actual["primary"]), len(actual["secondary"]), len(actual["dedup"])))
        self.close_mission()

    def test_registered_canonical_receipt_and_version_recovery(self):
        f = self.f
        f.setup()
        with tempfile.TemporaryDirectory(prefix="mp-trusted-executor-") as td:
            executor = Path(td) / "executor.py"
            executor.write_text("""import sys,os,json
from pathlib import Path
if sys.argv[1:] == ['--version']:
 print('canonical-reference 1.0')
else:
 work,out=map(Path,sys.argv[1:])
 assert (work/'verify.py').is_file()
 assert not os.getenv('COMPOSE_FILE') and not os.getenv('SENTINEL_SECRET')
 assert 'usable report' in (work/'verify.py').read_text()
 print(json.dumps({'checks':{'actual_frozen_source':'pass'},'result':'pass'}))
""", encoding="utf-8")
            data = dict(id="canonical", kind="command", executor_argv=[sys.executable, str(executor)],
                        executor_files=[str(executor)], command=["{work}", "{out}"], required_inputs=["verify.py"], expected_version="wrong-version")
            refuses(self, "ENVIRONMENT_MISMATCH", lambda: f.call("principal", "canonical.register", **data))
            data["expected_version"] = "canonical-reference 1.0"
            f.call("principal", "canonical.register", **data)
            f.call("pm", "requirement.record", id="canonical-run", task="t", argv=["{canonical}"], inputs=["verify.py"], environment="canonical",
                   predicate={"kind":"check_set", "checks":{"actual_frozen_source":"pass"}})
            f.review_admit()
            executed = f.call("constructor", "run.execute", requirement="canonical-run", admission=f.admission)["run"]
            self.assertTrue(executed["satisfied"])
            self.assertEqual("canonical_profile_execution", executed["execution_kind"])
            self.assertEqual("controller-execution", executed["assurance"])
            f.accept()
            self.close_mission()

    def test_compose_parser_runs_inside_allowlist_before_effect_checks(self):
        f = self.f
        f.setup()
        with tempfile.TemporaryDirectory(prefix="mp-compose-executor-") as td:
            trusted = Path(td)
            marker = trusted / "host-private-marker"
            marker.write_text("private input must not enter parser", encoding="utf-8")
            executor = trusted / "executor.py"
            executor.write_text("""import sys,json
from pathlib import Path
if sys.argv[1:] == ['--version']:
 print('compose-reference 1.0')
elif 'config' in sys.argv:
 assert not Path(%r).exists(), 'host parser escaped'
 p=Path(sys.argv[sys.argv.index('-f')+1])
 config=json.loads(p.read_text())
 print(json.dumps(config))
else:
 config=json.loads(Path(sys.argv[sys.argv.index('-f')+1]).read_text())
 service=config['services']['verify']
 assert service['network_mode']=='none' and service['read_only']
 assert service['volumes'][-1]['target']=='/out'
 work=Path(sys.argv[sys.argv.index('--project-directory')+1])
 assert 'usable report' in (work/'verify.py').read_text()
 print('PASS canonical frozen configuration and source')
""" % str(marker), encoding="utf-8")
            (f.root / "compose.json").write_text(json.dumps({"services":{"verify":{"image":"reference-image", "privileged":True}}}), encoding="utf-8")
            f.call("principal", "canonical.register", id="compose-env", kind="compose", executor_argv=[sys.executable, str(executor)],
                   executor_files=[str(executor)], required_inputs=["compose.json", "verify.py"], expected_version="compose-reference 1.0", compose_file="compose.json", service="verify")
            f.call("pm", "requirement.record", id="compose-run", task="t", argv=["{canonical}"], inputs=["compose.json", "verify.py"], environment="compose-env")
            f.review_admit()
            refuses(self, "CANONICAL_EFFECT_CONFLICT", lambda: f.call("constructor", "run.execute", requirement="compose-run", admission=f.admission))
            self.assertFalse(any(k == "run" for k, _ in f.engine.store.read()))
            (f.root / "compose.json").write_text(json.dumps({"services":{"verify":{"image":"reference-image"}}}), encoding="utf-8")
            result = f.call("constructor", "run.execute", requirement="compose-run", admission=f.admission)["run"]
            self.assertTrue(result["satisfied"])
            environment = json.loads(f.engine.store.blobs.get(result["environment_blob"]))
            self.assertIn("effective_config_blob", environment)
            self.assertEqual("private input must not enter parser", marker.read_text())
            f.accept()
            self.close_mission()


if __name__ == "__main__":
    if os.name == "nt":
        root = "/mnt/" + ROOT.drive[0].lower() + ROOT.as_posix()[2:]
        result = subprocess.run(["wsl", "--distribution", "Ubuntu", "--cd", root, "--exec", "/usr/bin/python3", "tests/m13_managed_recovery.py"])
        raise SystemExit(result.returncode)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ManagedRecoveryTests)
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
