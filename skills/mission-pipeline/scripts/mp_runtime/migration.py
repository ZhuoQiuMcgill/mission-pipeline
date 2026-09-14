"""Read-only legacy evidence interpretation and transactional schema-4 adoption."""
import hashlib
import json
import os
import time
import shutil
from pathlib import Path

from .markdown import document_fields
from .process import RuntimeRefusal
from .storage import digest, atomic_bytes, install_database
from .process import json_bytes


def read_legacy(journal):
    raw = Path(journal).read_bytes()
    events, expected = [], 1
    for line in raw.splitlines():
        try:
            event = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise RuntimeRefusal("LEGACY_JOURNAL_CORRUPTION", "Legacy event cannot be decoded; no records skipped") from exc
        if event.get("seq") != expected:
            raise RuntimeRefusal("LEGACY_SEQUENCE_GAP", "Legacy journal has a gap or reordering")
        events.append(event)
        expected += 1
    return raw, events


def calibration_bridge(events):
    """Only aggregate waves ratchet; task ALIGNED never breaks that sequence."""
    verdicts, wave_order, wave_heads, latches, unresolved = {}, {}, {}, [], []
    for event in events:
        if event.get("result") != "OK":
            continue
        p, action = event.get("payload", {}), event.get("action")
        if action == "artifact.sealed":
            artifact = p.get("artifact", {})
            mission = artifact.get("mission")
            for verdict in p.get("verdicts", []):
                kind = verdict.get("kind")
                if kind not in ("DRIFT", "SUSPICION", "ALIGNED"):
                    continue
                vid = verdict.get("id")
                target = dict(verdict, mission=mission, seq=event["seq"], artifact=artifact.get("id"))
                verdicts[vid] = target
                key = artifact.get("key", "")
                # v3 aggregate documents have key W<n>, task cells use T<n>.
                aggregate = key.startswith("W") and key[1:].isdigit()
                if kind == "DRIFT":
                    latches.append(dict(kind="DRIFT", mission=mission, triggers=[vid],
                                        event=event["seq"], scope=key, active=True, release=None))
                if aggregate:
                    order = wave_order.setdefault(mission, [])
                    heads = wave_heads.setdefault(mission, {})
                    if key not in heads:
                        order.append(key)
                    heads[key] = target
                    if len(order) >= 2 and all(heads[w]["kind"] == "SUSPICION" for w in order[-2:]):
                        pair = [heads[w]["id"] for w in order[-2:]]
                        if not any(l["kind"] == "RATCHET" and l["triggers"] == pair for l in latches):
                            latches.append(dict(kind="RATCHET", mission=mission, triggers=pair,
                                                event=event["seq"], scope="mission", active=True, release=None))
        if action == "supersede" and p.get("kind") == "verdict":
            target = p.get("target")
            by = p.get("by")
            reason = p.get("reason", "")
            # Old payloads may carry by in a structured field; preserve exact successful meaning.
            if by == "principal" and reason:
                for latch in latches:
                    if target in latch["triggers"] and latch["event"] < event["seq"] and latch["active"]:
                        latch.update(active=False, release=event["seq"], source_assurance="legacy-recorded")
            elif target in verdicts and verdicts[target]["kind"] in ("DRIFT", "SUSPICION"):
                for latch in latches:
                    if target in latch["triggers"] and latch["active"]:
                        latch["status"] = "LEGACY_AUTH_UNRESOLVED"
    return {"latches": latches, "unresolved": unresolved, "verdicts": verdicts}


def legacy_acceptances(events, missions):
    """Every recorded v3 acceptance verdict, as an adoptable credit.

    A sealed GroupReport carries the stabilizer's ACCEPTED verdict for one task
    cell. That judgement was earned once; 2.1 lets the PM credit it instead of
    re-running the whole chain for work the legacy mission already finished.
    """
    items = []
    for event in events:
        if event.get("result") != "OK" or event.get("action") != "artifact.sealed":
            continue
        payload = event.get("payload", {})
        artifact = payload.get("artifact") or {}
        if not any(v.get("kind") == "ACCEPTED" for v in payload.get("verdicts", [])):
            continue
        mission = artifact.get("mission")
        items.append({"legacy_mission": mission,
                      "mission_name": (missions.get(mission) or {}).get("name"),
                      "task_key": artifact.get("key"), "artifact": artifact.get("id"),
                      "sha256": artifact.get("sha256"), "seq": event["seq"]})
    return items


def adoption_plan(ledger, source_root=None):
    ledger = Path(ledger)
    journal = ledger / "events.jsonl"
    raw, events = read_legacy(journal)
    bridge = calibration_bridge(events)
    artifacts, missions, contracts = {}, {}, {}
    source_lines = raw.splitlines(keepends=True)
    for event in events:
        if event.get("result") != "OK":
            continue
        p = event.get("payload", {})
        declared = p.get("contracts", []) if event["action"] == "artifact.sealed" else [p] if event["action"] == "contract.add" else []
        for contract in declared:
            contracts[str(contract["id"])] = dict(contract, scope="legacy_project", active=not contract.get("retired_at"),
                  mission=p.get("mission_name"), source_event=event["seq"],
                  source_event_text=source_lines[event["seq"] - 1].decode("utf-8"), source_assurance="legacy-recorded")
        if event["action"] == "supersede" and p.get("kind") == "contract" and str(p.get("target")) in contracts:
            contract = contracts[str(p["target"])]
            contract.update(active=False, retired_at=event.get("at"), retirement_event=event["seq"],
                            retirement_record=dict(p), retirement_source_text=source_lines[event["seq"] - 1].decode("utf-8"))
        if event["action"] == "mission.claim":
            missions[p["id"]] = dict(p, status="open")
        if event["action"] == "mission.close":
            # The released 1.x dispatcher journals `mission.close` as {id, name, closed_at}
            # (the same `id` as `mission.claim`); a `mission` field appears only in the
            # sealed-MissionClose form handled below.
            mid = p.get("mission", p.get("id"))
            missions.setdefault(mid, {"id": mid})["status"] = "closed"
        if event["action"] == "artifact.sealed":
            a = p.get("artifact")
            if a:
                artifacts[a["id"]] = a
            claim = p.get("mission_claim")
            if claim:
                missions[claim["id"]] = dict(claim, status="open")
            close = p.get("mission_close")
            if close:
                mid = close.get("mission", close.get("id"))
                missions.setdefault(mid, {"id": mid})["status"] = "closed"
    overlays = []
    root = Path(source_root) if source_root else ledger
    for aid, artifact in artifacts.items():
        path = Path(artifact.get("path", ""))
        source = path if path.is_absolute() else root / path
        # Archive exports omit the installation-only .claude prefix.
        if not source.exists() and not path.is_absolute() and path.parts[:1] == (".claude",):
            source = root.joinpath(*path.parts[1:])
        expected = artifact.get("sha256")
        item = {"artifact": aid, "mission": artifact.get("mission"), "key": artifact.get("key"),
                "category": artifact.get("category"), "path": str(path),
                "expected_sha256": expected, "status": "UNAVAILABLE"}
        if source.is_file():
            content = source.read_bytes()
            actual = hashlib.sha256(content).hexdigest()
            if expected and actual == expected:
                item.update(status="VERIFIED", source_sha256=actual,
                            source_path=str(source.resolve()), fields=document_fields(content, legacy=True))
            elif not expected:
                item["status"] = "LEGACY_UNHASHED"
            else:
                item["status"] = "HASH_MISMATCH"
        overlays.append(item)
    return {"source_seq": len(events), "journal_sha256": hashlib.sha256(raw).hexdigest(),
            "bridge": bridge, "overlays": overlays, "missions": missions, "contracts": list(contracts.values()),
            "acceptances": legacy_acceptances(events, missions),
            "legacy_event_count": len(events), "ready": not bridge["unresolved"]}


def adoption_state(plan):
    state = {}
    def put(kind, id, data):
        state[(kind, str(id))] = {"revision": 1, "data": dict(data, id=str(id))}
    put("legacy_inventory", "source", plan)
    for contract in plan.get("contracts", []):
        cid = "legacy:" + str(contract["id"])
        aid = "legacy-contract-authority:" + str(contract["id"])
        put("authority", aid, {"active": True, "source_blob": contract["source_blob"], "goals": [], "constraints": {},
                               "constraint_scopes": {}, "source_assurance": "legacy-recorded"})
        put("contract", cid, dict(contract, authority=aid, clause=None, precedence="legacy-recorded",
                                  principal_ratified=bool(contract.get("ratified_at"))))
    for index, latch in enumerate(plan["bridge"]["latches"]):
        put("legacy_latch", index, latch)
    for item in plan["overlays"]:
        put("semantic_overlay", item["artifact"], item)
    put("readiness", "legacy", {"status": "READY", "source_seq": plan["source_seq"],
                                "journal_sha256": plan["journal_sha256"], "plan_digest": digest(plan)})
    return state


_ACTIVE_MIGRATIONS = set()
_MIGRATION_GUARD = __import__("threading").Lock()


def migrate(store, plan, actor):
    key = str(store.path.resolve())
    with _MIGRATION_GUARD:
        if key in _ACTIVE_MIGRATIONS:
            raise RuntimeRefusal("LEGACY_WRITER_BUSY", "Another migration is active in this process")
        _ACTIVE_MIGRATIONS.add(key)
    try:
        return _migrate(store, plan, actor)
    finally:
        with _MIGRATION_GUARD:
            _ACTIVE_MIGRATIONS.remove(key)


def _migrate(store, plan, actor):
    """Fence the released writer and publish legacy bridge + readiness atomically."""
    if not plan["ready"]:
        raise RuntimeRefusal("MIGRATION_INCOMPLETE", "Resolve unknown legacy events before adoption")
    if store.owner_path.exists():
        from .environment import environment_id
        owner = json.loads(store.owner_path.read_bytes())
        if owner["environment"] != environment_id():
            raise RuntimeRefusal("WRITER_ENVIRONMENT_MISMATCH", "Migration recovery belongs to its existing writer environment")
        if not store.manifest_path.exists() and owner["state"] == "BOOTSTRAP":
            store.maintenance("recover")
    for overlay in plan["overlays"]:
        if overlay["status"] == "VERIFIED":
            raw_source = Path(overlay["source_path"]).read_bytes()
            if hashlib.sha256(raw_source).hexdigest() != overlay["source_sha256"]:
                raise RuntimeRefusal("LEGACY_SOURCE_CHANGED", "Legacy document changed during adoption")
            overlay["source_blob"] = store.blobs.put(raw_source)
    for contract in plan.get("contracts", []):
        contract["source_blob"] = store.blobs.put(contract["source_event_text"].encode("utf-8"))
        if contract.get("retirement_source_text"):
            contract["retirement_blob"] = store.blobs.put(contract["retirement_source_text"].encode("utf-8"))
    if store.manifest_path.exists():
        if (store.manifest().get("legacy") or {}).get("sha256") != plan["journal_sha256"]:
            raise RuntimeRefusal("LEGACY_SOURCE_CHANGED", "This v4 ledger belongs to a different frozen legacy source")
        if json.loads(store.owner_path.read_bytes()).get("state") == "BOOTSTRAP":
            store.maintenance("recover")
        return install_adoption(store, plan, actor)
    lock = store.path / ".mp.lock"
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        try:
            prior = json.loads(lock.read_bytes())
        except (OSError, ValueError):
            prior = {}
        from .environment import environment_id
        if not prior.get("schema4_fence") or prior.get("source_sha256") != plan["journal_sha256"] or prior.get("environment") != environment_id():
            raise RuntimeRefusal("LEGACY_WRITER_BUSY", "Legacy writer must be stopped before adoption") from exc
        pid = prior.get("pid")
        if pid != os.getpid():
            if os.name == "nt":
                import ctypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.restype = ctypes.c_void_p
                handle = kernel.OpenProcess(0x1000, False, pid)
                alive = bool(handle)
                if handle:
                    kernel.CloseHandle(ctypes.c_void_p(handle))
            else:
                try:
                    os.kill(pid, 0)
                    alive = True
                except ProcessLookupError:
                    alive = False
                except PermissionError:
                    alive = True
            if alive:
                raise RuntimeRefusal("LEGACY_WRITER_BUSY", "Original migration process is still alive")
        fd = None
    if fd is not None:
        with os.fdopen(fd, "wb") as out:
            from .environment import environment_id
            out.write(json_bytes({"schema4_fence": True, "source_sha256": plan["journal_sha256"], "environment": environment_id(), "pid": os.getpid()}))
            out.flush()
            os.fsync(out.fileno())
    raw = (store.path / "events.jsonl").read_bytes()
    if hashlib.sha256(raw).hexdigest() != plan["journal_sha256"]:
        raise RuntimeRefusal("LEGACY_SOURCE_CHANGED", "Journal changed after migration planning")
    frozen = store.path / "legacy" / (plan["journal_sha256"] + ".jsonl")
    atomic_bytes(frozen, raw)
    if store.db_path.exists():
        backup = store.path / "legacy" / "before-v4.db"
        install_database(store.db_path, backup)
    metadata = {"path": frozen.relative_to(store.path).as_posix(), "sha256": plan["journal_sha256"],
                "original": "events.jsonl", "backup": "legacy/before-v4.db"}
    from .legacy_v3 import replay
    projection = store.path / "legacy" / "replayed-v3.db"
    # The released dispatcher's replay tolerates a malformed historical line the
    # way its live path did — rolled back whole, reported, never fatal (its own
    # `rebuild` and `doctor` pass a list for exactly this). Import that
    # semantics unchanged and keep the record of what was skipped.
    skipped = []
    connection = replay(frozen, projection, skipped)
    connection.close()
    install_database(projection, store.db_path)
    metadata["replay_skipped"] = [{"seq": seq, "action": action, "error": error} for seq, action, error in skipped]
    def bootstrap(target, conn):
        target.apply(conn, event)
        atomic_bytes(target.path / target.manifest()["segments"][0]["path"], json_bytes(event))
    request = {"request_id": "migration-" + plan["journal_sha256"], "action": "migration.install", "data": plan}
    result = {"ok": True, "ready": True, "legacy_events": plan["source_seq"], "replay_skipped": len(skipped)}
    event = dict(version=4, seq=1, request_id=request["request_id"], payload_hash=digest(request), request=request,
                 actor=actor.record(), epoch=1, at=time.time(), result=result,
                 actions=[dict(op="put", kind=k, id=i, revision=1, body=row["data"])
                          for (k, i), row in sorted(adoption_state(plan).items())])
    event["checksum"] = digest(event)
    metadata["bootstrap_event_blob"] = store.blobs.put(json_bytes(event))
    store.initialize(legacy=metadata, bootstrap=bootstrap)
    return {"ok": True, "ready": True, "legacy_events": plan["source_seq"]}


def install_adoption(store, plan, actor):
    if not plan["ready"]:
        raise RuntimeRefusal("MIGRATION_INCOMPLETE", "Unresolved legacy events prevent readiness")
    request = {"request_id": "migration-" + plan["journal_sha256"], "action": "migration.install", "data": plan}
    def callback(state):
        state.update(adoption_state(plan))
        return {"ok": True, "ready": True, "legacy_events": plan["source_seq"]}
    return store.transact(request, actor.record(), callback)


def rollback(store):
    """Retire the v4 sidecar only before any v4 business transition exists."""
    from .storage import ShortLock
    from .environment import environment_id
    owner = json.loads(store.owner_path.read_bytes().decode("utf-8"))
    if owner["environment"] != environment_id():
        raise RuntimeRefusal("WRITER_ENVIRONMENT_MISMATCH", "Rollback belongs to the current owner environment")
    with ShortLock(store.path / ".runtime.lock"):
        retired = store.path / "retired-v4"
        manifest_path = store.manifest_path if store.manifest_path.exists() else retired / "runtime-manifest.json"
        manifest = json.loads(manifest_path.read_bytes().decode("utf-8"))
        if not manifest.get("legacy"):
            raise RuntimeRefusal("ROLLBACK_UNAVAILABLE", "This is not a legacy adoption")
        if owner["state"] != "ROLLING_BACK":
            events = store.events()
            if any(not event["request_id"].startswith("migration-") for event in events):
                raise RuntimeRefusal("ROLLBACK_AFTER_BUSINESS", "Keep v4 history after its first business transition")
            owner["state"] = "ROLLING_BACK"
            atomic_bytes(store.owner_path, json_bytes(owner))
        legacy = manifest["legacy"]
        journal = store.path / legacy["path"]
        if hashlib.sha256(journal.read_bytes()).hexdigest() != legacy["sha256"]:
            raise RuntimeRefusal("LEGACY_SOURCE_CHANGED", "Rollback source bytes are unavailable")
        from .legacy_v3 import replay
        projection = store.path / "legacy" / "rollback-v3.db"
        conn = replay(journal, projection, [])
        conn.close()
        install_database(projection, store.db_path)
        retired.mkdir(exist_ok=True)
        if store.manifest_path.exists():
            os.replace(store.manifest_path, retired / "runtime-manifest.json")
        if (store.path / "segments").exists():
            if (retired / "segments").exists():
                raise RuntimeRefusal("ROLLBACK_CONFLICT", "Retired journal directory already exists")
            os.replace(store.path / "segments", retired / "segments")
        atomic_bytes(retired / "owner.json", json_bytes(owner))
        fence = store.path / ".mp.lock"
        if fence.exists():
            marker = json.loads(fence.read_bytes().decode("utf-8"))
            if marker.get("schema4_fence"):
                fence.unlink()
        # Delete only this generated owner record; all journals, blobs and receipts stay preserved.
        store.owner_path.unlink()
        store.owner_path.parent.rmdir()
    return {"ok": True, "schema": 3, "retired_history": str(retired), "source_sha256": legacy["sha256"]}
