import base64
import concurrent.futures
import contextlib
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from v4_support import ROOT, Fixture, refuses
from mp_runtime.process import read_json_bytes, json_bytes, run_bytes
from mp_runtime.paths import resolve_ref, source_manifest, contained
from mp_runtime.managed import ManagedBroker
from mp_runtime.workflow import Actor


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)

    def test_unrelated_ticket_survives_scoped_pending_and_target_is_fenced(self):
        f = self.f
        f.setup()
        f.call("pm", "plan.record", id="p2", mission="m", goals=["usable-report"], source_blob=f.blob,
               obligations=[dict(id="o2", goal="usable-report", description="independent work")])
        f.call("pm", "task.record", id="t2", mission="m", obligations=["o2"], grant="g", domain="method",
               effects=[], allowed_effects=[], inputs=[f.blob], source_blob=f.blob)
        review = f.call("supervisor", "plan.review", plan="p2", tasks=["t2"], outcome="PASS", source_blob=f.blob)["review"]
        admission = f.call("pm", "task.admit", task="t2", review=review["id"])["admission"]
        other = f.call("pm", "task.dispatch", admission=admission["id"])["ticket"]
        target = f.call("pm", "task.dispatch", admission=f.admission)["ticket"]
        case = f.issue()
        refuses(self, "SCOPED_BARRIER", lambda: f.call("constructor", "task.claim", ticket=target["id"]))
        self.assertTrue(f.call("constructor", "task.claim", ticket=other["id"])["claimed"])
        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
        f.call("stabilizer", "contest.decide", case=case["id"], outcome="DISMISS_ORIGINAL", source_blob=f.blob)
        refuses(self, "STALE_TICKET", lambda: f.call("constructor", "task.claim", ticket=target["id"]))
        fresh = f.call("pm", "task.dispatch", admission=f.admission)["ticket"]
        self.assertTrue(f.call("constructor", "task.claim", ticket=fresh["id"])["claimed"])

    def test_seed_changes_run_key_without_secret_in_receipts_or_packets(self):
        f = self.f
        f.setup()
        sentinel = "ENV-SECRET-never-disclose-38905"
        previous = os.environ.get("SENTINEL_SECRET")
        os.environ["SENTINEL_SECRET"] = sentinel
        try:
            runs = []
            for seed in ("1", "2"):
                f.call("principal", "environment.register", id="seed" + seed, executable=sys.executable, cwd=str(f.root), values={"PYTHONHASHSEED": seed})
                f.call("pm", "requirement.record", id="seed-run" + seed, task="t", argv=["{python}", "verify.py"], inputs=["verify.py"], environment="seed" + seed)
            f.review_admit()
            for seed in ("1", "2"):
                runs.append(f.call("constructor", "run.execute", requirement="seed-run" + seed, admission=f.admission)["run"])
            self.assertNotEqual(runs[0]["key"], runs[1]["key"])
            self.assertTrue(all(run["satisfied"] for run in runs))
            broker = ManagedBroker(f.engine)
            packet = broker.packet(broker.seat("auditor", "m"))
            self.assertNotIn(sentinel, json.dumps(packet))
            for run in runs:
                for field in ("environment_blob", "stdout_blob", "stderr_blob"):
                    self.assertNotIn(sentinel.encode(), f.engine.store.blobs.get(run[field]))
            self.assertNotIn(sentinel, json.dumps(f.engine.store.events()))
        finally:
            if previous is None:
                os.environ.pop("SENTINEL_SECRET", None)
            else:
                os.environ["SENTINEL_SECRET"] = previous

    def test_expected_negative_checkset_and_crash_do_not_collapse_to_pass(self):
        f = self.f
        f.setup()
        commands = {
            "negative": (["{python}", "-c", "import sys;print('EXPECTED diagnostic');sys.exit(7)"], {"kind":"expected_negative", "exit_code":7, "diagnostic":"EXPECTED diagnostic"}, True),
            "crash": (["{python}", "-c", "raise RuntimeError('unrelated')"], {"kind":"expected_negative", "exit_code":7, "diagnostic":"EXPECTED diagnostic"}, False),
            "partial": (["{python}", "-c", "print('{\"checks\":{\"a\":\"pass\"}}')"], {"kind":"check_set", "checks":{"a":"pass", "b":"pass"}}, False),
            "all": (["{python}", "-c", "print('{\"checks\":{\"a\":\"pass\",\"b\":\"pass\"}}')"], {"kind":"check_set", "checks":{"a":"pass", "b":"pass"}}, True),
        }
        for name, (argv, predicate, _) in commands.items():
            f.call("pm", "requirement.record", id=name, task="t", argv=argv, inputs=[], environment="env", predicate=predicate, required=False)
        f.review_admit()
        for name, (_, _, expected) in commands.items():
            run = f.call("constructor", "run.execute", requirement=name, admission=f.admission)["run"]
            self.assertEqual(expected, run["satisfied"], name)
        first = f.call("constructor", "run.execute", requirement="all", admission=f.admission)["run"]
        second = f.call("constructor", "run.execute", requirement="all", admission=f.admission)["run"]
        self.assertEqual(first["id"], second["id"])
        engine = f.engine.with_actor(Actor("constructor", "same-client"))
        request = {"action":"run.execute", "request_id":"same-execution-request", "data":{"requirement":"all", "admission":f.admission}}
        initial = engine.handle(request)["run"]
        retry = engine.handle(request)["run"]
        self.assertEqual(initial["id"], retry["id"])
        self.assertEqual("COMPLETE", retry["status"])
        self.assertTrue(retry["satisfied"])

    def test_packet_excludes_other_mission_authority_root_review_and_blobs(self):
        f = self.f
        f.setup()
        secret = f.engine.store.blobs.put(b"OTHER-MISSION-PRIVATE-SOURCE")
        f.call("principal", "authority.record", id="other-a", source_blob=secret, goals=["different"], constraints={})
        f.call("pm", "intake.create", id="other-i", authority="other-a", mission="other")
        f.call("pm", "root.propose", id="other-c", intake="other-i", source_blob=secret, goals=["different"])
        review = f.call("supervisor", "root.review", candidate="other-c", outcome="MATCH", source_blob=secret)["review"]
        f.call("pm", "root.activate", candidate="other-c", review=review["id"])
        broker = ManagedBroker(f.engine)
        seat = broker.seat("auditor", "m")
        packet = broker.packet(seat)
        self.assertNotIn(secret, packet["input_manifest"])
        self.assertFalse(any(row["object"].get("id") in ("other", "other-c", review["id"]) for row in packet["records"]))
        refuses(self, "INPUT_OUTSIDE_PACKET", lambda: broker.tool(seat, {"tool":"read_blob", "blob":secret}))

    def test_json_frames_and_target_platform_paths(self):
        for raw in (b'{"x":NaN}', b'{"x":1,"x":2}', b'{}\xff', b'{', b' ' * (8 * 1024 * 1024 + 1)):
            refuses(self, "INVALID_INPUT", lambda raw=raw: read_json_bytes(raw))
        self.assertEqual({"literal":"\r\n`$()\\"}, read_json_bytes(b'\xef\xbb\xbf' + json_bytes({"literal":"\r\n`$()\\"})))
        f = self.f
        self.assertFalse(contained(f.root / "ledger2", f.root / "ledger"))
        if os.name == "nt":
            for name in ("NUL.txt", "line\nname", "trailing.", "a:b"):
                code = "INVALID_PATH" if name == "a:b" else "UNREPRESENTABLE_PATH"
                refuses(self, code, lambda name=name: resolve_ref(f.root, name))
        else:
            names = ["line\nname", "literal\\backslash", "中文🙂 '$()`"]
            for name in names:
                path = resolve_ref(f.root, {"relative_segments":[name]})
                path.write_bytes(name.encode("utf-8"))
                self.assertEqual(name.encode("utf-8"), path.read_bytes())

    def test_task_write_permission_cannot_mutate_git_control_metadata(self):
        f = self.f
        f.setup()
        from mp_runtime.storage import digest
        task = f.engine.object("task", "t")
        f.call("pm", "task.record", **dict(task, revises=digest(task), write_paths=["verify.py", ".git/config"]))
        f.review_admit()
        refuses(self, "PRIVATE_INPUT_FORBIDDEN", lambda: f.call("constructor", "work.write", task="t", admission=f.admission, path=".git/config", source_blob=f.blob))
        self.assertFalse((f.root / ".git" / "config").exists())
        f.accept()

    def test_product_effect_crash_before_and_after_durable_append(self):
        f = self.f
        f.setup()
        path = f.root / "verify.py"
        previous = path.read_bytes()
        raw = previous + b"# reviewed replacement\n"
        sha = f.engine.store.blobs.put(raw)
        actor = Actor("constructor", "effect-test")
        request = {"request_id":"write-crash", "action":"work.write", "data":{"task":"t", "admission":f.admission,
                   "path":"verify.py", "expected_sha256":hashlib.sha256(previous).hexdigest(), "source_blob":sha}}
        engine = f.engine.with_actor(actor)
        engine.store.fault = lambda phase: (_ for _ in ()).throw(OSError("before")) if phase == "before_append" else None
        with self.assertRaises(OSError):
            engine.handle(request)
        self.assertEqual(previous, path.read_bytes())
        self.assertIsNone(engine.store.receipt("write-crash"))
        engine.store.fault = lambda phase: (_ for _ in ()).throw(OSError("after")) if phase == "after_product_effect" else None
        refuses(self, "COMMIT_DURABLE_RECOVERY_REQUIRED", lambda: engine.handle(request))
        self.assertEqual(raw, path.read_bytes())
        engine.store.fault = None
        recovered = engine.handle(request)
        self.assertTrue(recovered["reused"])
        self.assertEqual(1, len([e for e in engine.store.events() if e["request_id"] == "write-crash"]))
        engine.store.rebuild()
        self.assertEqual(raw, path.read_bytes())
        self.assertTrue(engine.store.doctor()["ok"])

    def test_pending_case_barrier_job_are_one_durable_envelope(self):
        f = self.f
        f.setup()
        engine = f.engine.with_actor(Actor("auditor", "atomic-auditor"))
        request = dict(action="issue.report", request_id="atomic-issue", data=dict(kind="MANDATORY_COUNTEREXAMPLE", mission="m",
                       source_blob=f.blob, counterexample_blob=f.blob, target="t", tasks=["t"], obligations=["o"]))
        engine.store.fault = lambda phase: (_ for _ in ()).throw(OSError("after fsync")) if phase == "after_fsync" else None
        refuses(self, "COMMIT_DURABLE_RECOVERY_REQUIRED", lambda: engine.handle(request))
        engine.store.fault = None
        result = engine.handle(request)
        case = result["case"]["id"]
        event = engine.store.receipt("atomic-issue")
        keys = {(item["kind"], item["id"]) for item in event["actions"]}
        self.assertTrue({("case", case), ("barrier", case), ("job", case + ":screen")}.issubset(keys))
        refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
        changed = dict(request, data=dict(request["data"], target="different"))
        refuses(self, "REQUEST_CONFLICT", lambda: engine.handle(changed))

    def test_actual_two_processes_cannot_publish_two_revision_heads(self):
        f = self.f
        f.setup()
        first = f.call("constructor", "report.record", kind="development", task="t", outcome="COMPLETE", source_blob=f.blob)["report"]
        mp = str(ROOT / "skills/mission-pipeline/scripts/mp")
        program = "import sys,subprocess;print('ready',flush=True);raw=sys.stdin.buffer.readline();r=subprocess.run(sys.argv[1:],input=raw,capture_output=True);sys.stdout.buffer.write(r.stdout);sys.exit(r.returncode)"
        children = [subprocess.Popen([sys.executable, "-c", program, sys.executable, mp, "--root", str(f.root), "--actor", "constructor", "api", "--stdio"],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        try:
            for child in children:
                self.assertEqual(b"ready\n", child.stdout.readline().replace(b"\r\n", b"\n"))
            for index, child in enumerate(children):
                request = dict(action="report.record", request_id="race-" + str(index), data=dict(kind="development", task="t", outcome="COMPLETE", source_blob=f.blob, revises=first["id"], round=2))
                child.stdin.write(json_bytes(request))
                child.stdin.flush()
            results = []
            for child in children:
                child.stdin.close()
                output = child.stdout.read()
                child.wait(timeout=20)
                results.append((child.returncode, json.loads(output)))
            self.assertEqual([0, 3], sorted(item[0] for item in results), results)
            self.assertEqual("STALE_HEAD", next(item[1]["code"] for item in results if item[0]))
            reports = [row["data"] for (kind, _), row in f.engine.store.read().items() if kind == "report"]
            self.assertEqual(2, len(reports))
            self.assertEqual(1, sum(row["current"] for row in reports))
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                    child.wait()
                child.stdout.close()
                child.stderr.close()

    def test_adapter_committed_view_failure_and_live_execution_do_not_block_reads(self):
        from unittest.mock import patch
        from mp_runtime.field_adapter import invoke, snapshot
        import time
        f = self.f
        f.setup()
        engine = f.engine.with_actor(Actor("pm", "adapter-seat"))
        request = {"action": "decision.record", "request_id": "adapter-view", "data": {"mission": "m", "grant": "g", "domain": "method", "choice": "plain readable output", "effects": {"layout": "plain"}, "rationale_blob": f.blob, "revises": "d"}}
        with patch("mp_runtime.field_adapter.publish", side_effect=OSError("isolated view failure")):
            committed = invoke(engine, request)
        self.assertTrue(committed["committed"])
        self.assertTrue(committed["view_stale"])
        recovered = invoke(engine, request)
        self.assertTrue(recovered["reused"])
        self.assertIn("view", recovered)
        with patch("mp_runtime.field_adapter.publish") as render:
            refuses(self, "AUTHORITY_CONFLICT", lambda: invoke(engine, {"action": "decision.record", "request_id": "adapter-refused", "data": dict(request["data"], effects={"privacy": "public"})}))
            render.assert_not_called()
        f.call("pm", "requirement.record", id="slow", task="t", argv=["{python}", "-c", "import time;time.sleep(2);print('pass')"], inputs=[], environment="env", required=False)
        f.review_admit()
        executor = f.engine.with_actor(Actor("constructor", "live-process"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(executor.handle, {"action": "run.execute", "request_id": "live-process", "data": {"requirement": "slow", "admission": f.admission}})
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                rows = snapshot(f.engine)["objects"]
                if any(row["kind"] == "run" and row["body"]["status"] == "RUNNING" for row in rows):
                    break
                if future.done():
                    self.fail("execution completed without an observable pending snapshot")
                time.sleep(0.01)
            else:
                self.fail("execution did not publish its pending generation")
            self.assertFalse(future.done())
            f.call("principal", "project.configure", mode="local")
            self.assertTrue(future.result(timeout=10)["run"]["satisfied"])

    def test_killed_process_recovers_root_pending_contest_and_release_atomically(self):
        for operation in ("root", "pending", "proposal", "release"):
            with self.subTest(operation=operation):
                f = Fixture()
                self.addCleanup(f.close)
                f.setup()
                if operation == "root":
                    candidate = f.call("pm", "root.propose", intake="i", revises="c", goals=["usable-report"], source_blob=f.blob)["candidate"]
                    review = f.call("supervisor", "root.review", candidate=candidate["id"], outcome="MATCH", source_blob=f.blob)["review"]
                    role, action, data = "pm", "root.activate", {"candidate": candidate["id"], "review": review["id"], "revises_root": "c"}
                    expected = {"root", "candidate", "fence"}
                elif operation == "pending":
                    role, action, data = "auditor", "issue.report", dict(kind="MANDATORY_COUNTEREXAMPLE", mission="m", source_blob=f.blob, counterexample_blob=f.blob, target="t", tasks=["t"], obligations=["o"])
                    expected = {"case", "barrier", "job", "fence"}
                else:
                    case = f.issue()
                    if operation == "proposal":
                        role, action, data = "supervisor", "issue.screen", {"case": case["id"], "outcome": "DISMISSED", "source_blob": f.blob}
                        expected = {"case", "barrier", "contest", "job"}
                    else:
                        f.call("supervisor", "issue.screen", case=case["id"], outcome="DISMISSED", source_blob=f.blob)
                        role, action, data = "stabilizer", "contest.decide", {"case": case["id"], "outcome": "DISMISS_ORIGINAL", "source_blob": f.blob}
                        expected = {"case", "barrier", "contest"}
                if action in ("issue.screen", "contest.decide"):
                    data = dict(data, **f.engine.handle({"action": "review.snapshot", "data": data}))
                request = {"action": action, "data": data, "request_id": "killed-" + operation}
                script = "import os,sys,json;sys.path.insert(0,sys.argv[1]);from mp_runtime.engine import Engine;from mp_runtime.workflow import Actor;e=Engine(sys.argv[2],Actor(sys.argv[3],'crash-seat'));e.store.fault=lambda phase:os._exit(97) if phase=='after_fsync' else None;e.handle(json.loads(sys.stdin.buffer.read()))"
                child = run_bytes([sys.executable, "-c", script, str(ROOT / "skills/mission-pipeline/scripts"), str(f.root), role], input_bytes=json_bytes(request))
                self.assertEqual(97, child.returncode, child.stderr)
                engine = f.engine.with_actor(Actor(role, "crash-seat"))
                result = engine.handle(request)
                self.assertTrue(result["reused"])
                events = [event for event in engine.store.events() if event["request_id"] == request["request_id"]]
                self.assertEqual(1, len(events))
                self.assertTrue(expected.issubset({item["kind"] for item in events[0]["actions"]}), events[0]["actions"])
                self.assertTrue(engine.store.doctor()["ok"])
                if operation == "root":
                    self.assertEqual(2, engine.object("root", "m")["version"])
                    self.assertEqual("ACTIVE", engine.object("candidate", candidate["id"])["status"])
                elif operation == "pending":
                    refuses(self, "SCOPED_BARRIER", lambda: f.call("pm", "task.dispatch", admission=f.admission))
                elif operation == "proposal":
                    self.assertEqual("PENDING", engine.object("contest", case["id"])["status"])
                else:
                    self.assertEqual("RELEASED", engine.object("barrier", case["id"])["phase"])
                    f.call("pm", "task.dispatch", admission=f.admission)

    def test_write_cost_follows_the_journal_tail_not_its_length(self):
        """S16: every write used to re-read, re-checksum and re-compare the whole
        journal. The watermark keeps the tail verified; full replay stays in
        doctor(), rebuild() and `maintenance recover`."""
        store = self.f.engine.store
        engine = self.f.engine.with_actor(Actor("principal", "seat:principal"))
        times = []
        for i in range(600):
            start = time.perf_counter()
            engine.mutate("project.configure", {"mode": "local"}, "cost-probe-" + str(i))
            times.append(time.perf_counter() - start)
        first, last = sum(times[:100]) / 100, sum(times[-100:]) / 100
        self.assertLessEqual(last, 2 * first,
                             "per-write cost grew with journal length: %.4fs -> %.4fs" % (first, last))
        with contextlib.closing(store.connect(readonly=True)) as conn:
            mark = store.watermark(conn)
        segment = store.path / store.manifest()["segments"][-1]["path"]
        self.assertEqual(store.inspect()["seq"], mark["verified_seq"])
        self.assertEqual(segment.stat().st_size, mark["offset"])
        self.assertEqual(store.manifest()["segments"], mark["segments"])
        # No watermark, or one that does not match the projection: verify in full.
        with contextlib.closing(store.connect()) as conn:
            conn.execute("DELETE FROM runtime_meta WHERE key='journal_watermark'")
            conn.commit()
        self.assertFalse(store.tail_recover())
        store.recover()
        self.assertTrue(store.doctor()["ok"])
        # The tail path trusts its watermark; the full paths still catch a
        # projection written outside the write path.
        with contextlib.closing(store.connect()) as conn:
            conn.execute("UPDATE runtime_objects SET body=? WHERE kind='config'", ('{"id":"project","mode":"forged"}',))
            conn.commit()
        store.recover()
        refuses(self, "DATABASE_DIVERGENCE", lambda: store.recover(full=True))
        refuses(self, "DATABASE_DIVERGENCE", lambda: store.doctor())
        self.assertTrue(store.rebuild()["ok"])
        self.assertTrue(store.doctor()["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
