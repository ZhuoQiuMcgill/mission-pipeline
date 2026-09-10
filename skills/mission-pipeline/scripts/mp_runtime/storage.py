"""Versioned journal, immutable blobs, one writer environment, disposable SQLite.

The journal is authoritative. A durable append followed by a database failure is
not an uncommitted operation: retry with the SAME request id to recover receipt.
"""
import contextlib
import copy
import hashlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

from .environment import environment_id
from .process import RuntimeRefusal, json_bytes

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
INSERT INTO schema_meta(version) SELECT 4 WHERE NOT EXISTS(SELECT 1 FROM schema_meta);
CREATE TABLE IF NOT EXISTS runtime_objects(
 kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
 body TEXT NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS runtime_events(
 seq INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
 payload_hash TEXT NOT NULL, envelope TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
"""


def digest(value):
    # JSON object keys are strings on disk, including imported numeric legacy ids.
    normalized = json.loads(json.dumps(value, ensure_ascii=True, allow_nan=False))
    return hashlib.sha256(json_bytes(normalized)).hexdigest()


def sync_dir(path):
    if os.name != "nt":
        fd = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic_bytes(path, raw):
    from .paths import io_path
    path = io_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = io_path(path.with_name(path.name + ".tmp-" + uuid.uuid4().hex))
    try:
        with open(tmp, "xb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        if tmp.exists():
            tmp.unlink()


def install_database(source, target, timeout=10):
    """SQLite's backup transaction works even when an idle reader owns the file.

    Replacing an open database inode is unsafe on Windows and splits readers on
    POSIX. SQLite instead coordinates an atomic destination write transaction.
    """
    deadline = time.monotonic() + timeout
    src = sqlite3.connect(str(source))
    dst = sqlite3.connect(str(target), timeout=timeout)
    try:
        def progress(status, remaining, total):
            if time.monotonic() > deadline:
                raise RuntimeRefusal("BUSY_RETRYABLE", "Database installation is waiting for an active reader")
        src.backup(dst, pages=128, progress=progress, sleep=0.02)
    finally:
        dst.close()
        src.close()


class ShortLock:
    """Same-owner-environment lock. NOT a Windows/WSL arbitration primitive."""
    def __init__(self, path, timeout=10):
        self.path, self.timeout, self.file = Path(path), timeout, None

    def __enter__(self):
        self.file = open(self.path, "a+b")
        if self.file.seek(0, os.SEEK_END) == 0:
            self.file.write(b"0")
            self.file.flush()
        end = time.monotonic() + self.timeout
        while True:
            try:
                self.file.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except (OSError, BlockingIOError):
                if time.monotonic() >= end:
                    self.file.close()
                    raise RuntimeRefusal("BUSY_RETRYABLE", "Writer lock is busy")
                time.sleep(0.02)

    def __exit__(self, *args):
        try:
            self.file.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        finally:
            self.file.close()


class BlobStore:
    def __init__(self, root):
        self.root = Path(root)

    def put(self, raw):
        sha = hashlib.sha256(raw).hexdigest()
        dest = self.root / sha[:2] / sha[2:]
        if dest.exists():
            if dest.read_bytes() != raw:
                raise RuntimeRefusal("CAS_CORRUPTION", "Existing blob does not match its identity")
        else:
            atomic_bytes(dest, raw)
        return sha

    def get(self, sha):
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise RuntimeRefusal("INVALID_BLOB", "Invalid blob id")
        try:
            raw = (self.root / sha[:2] / sha[2:]).read_bytes()
        except OSError as exc:
            raise RuntimeRefusal("EVIDENCE_UNAVAILABLE", "Immutable blob is unavailable", blob=sha) from exc
        if hashlib.sha256(raw).hexdigest() != sha:
            raise RuntimeRefusal("CAS_CORRUPTION", "Immutable blob hash mismatch", blob=sha)
        return raw


class RuntimeStore:
    def __init__(self, ledger):
        from .paths import io_path
        self.path = io_path(Path(ledger).resolve(), force=True)
        self.owner_path = self.path / ".writer-owner" / "owner.json"
        self.manifest_path = self.path / "runtime-manifest.json"
        self.db_path = self.path / "mp.db"
        self.blobs = BlobStore(self.path / "blobs")
        self.fault = None  # In-process test hook; never configurable by a role request.

    def checkpoint(self, name):
        if self.fault:
            self.fault(name)

    def owner(self, write=False):
        try:
            owner = json.loads(self.owner_path.read_bytes().decode("utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeRefusal("BOOTSTRAP_INCOMPLETE", "Owner manifest is incomplete; use trusted maintenance") from exc
        if write and owner["environment"] != environment_id():
            raise RuntimeRefusal("WRITER_ENVIRONMENT_MISMATCH", "Use the owner environment broker/bridge",
                                 owner_environment=owner["environment"])
        if owner["state"] != "READY":
            code = "BOOTSTRAP_INCOMPLETE" if owner["state"] == "BOOTSTRAP" else "OWNER_QUIESCED"
            raise RuntimeRefusal(code, "Writer environment is not ready")
        return owner

    def initialize(self, legacy=None, bootstrap=None):
        self.path.mkdir(parents=True, exist_ok=True)
        if self.db_path.exists() and not self.owner_path.exists() and legacy is None:
            raise RuntimeRefusal("LEGACY_MIGRATION_REQUIRED", "Use migrate before writing a legacy ledger")
        slot = self.path / ".writer-owner"
        owner = dict(environment=environment_id(), epoch=1, state="BOOTSTRAP", project=uuid.uuid4().hex, bootstrap_legacy=legacy)
        prepared = self.path / (".bootstrap-owner-" + uuid.uuid4().hex)
        prepared.mkdir()
        atomic_bytes(prepared / "owner.json", json_bytes(owner))
        try:
            self.checkpoint("bootstrap_prepared")
            if slot.exists():
                self.owner(write=True)
                return self.inspect()
            try:
                # Publish a NONEMPTY directory: both NTFS and POSIX refuse replacing
                # the other initializer's already-published nonempty owner directory.
                os.rename(prepared, slot)
                sync_dir(self.path)
            except OSError:
                if not slot.exists():
                    raise
                self.owner(write=True)
                return self.inspect()
        finally:
            if prepared.exists():
                (prepared / "owner.json").unlink()
                prepared.rmdir()
        self.checkpoint("bootstrap_owner")
        manifest = dict(version=4, project=owner["project"], epoch=1,
                        legacy=legacy, segments=[{"path": "segments/000001.jsonl", "limit": None}])
        (self.path / "segments").mkdir(exist_ok=True)
        atomic_bytes(self.path / manifest["segments"][0]["path"], b"")
        self.save_manifest(manifest)
        self.checkpoint("bootstrap_manifest")
        conn = self.connect()
        try:
            if bootstrap:
                bootstrap(self, conn)
            conn.commit()
        finally:
            conn.close()
        self.checkpoint("bootstrap_database")
        owner["state"] = "READY"
        atomic_bytes(self.owner_path, json_bytes(owner))
        return self.inspect()

    def maintenance(self, operation, target_environment=None):
        """Trusted CLI only. Handoff is an explicit fenced two-environment protocol."""
        owner = json.loads(self.owner_path.read_bytes().decode("utf-8"))
        current_env = environment_id()
        if operation == "accept":
            if owner["state"] != "HANDOFF" or owner.get("target_environment") != current_env:
                raise RuntimeRefusal("HANDOFF_SCOPE", "Only the named destination environment can accept")
            with ShortLock(self.path / ".runtime.lock"):
                latest = json.loads(self.owner_path.read_bytes().decode("utf-8"))
                if latest != owner:
                    raise RuntimeRefusal("STALE_EPOCH", "Handoff was already consumed")
                owner.update(environment=current_env, state="BOOTSTRAP", epoch=owner["epoch"] + 1)
                atomic_bytes(self.owner_path, json_bytes(owner))
                manifest = self.manifest()
                manifest["epoch"] = owner["epoch"]
                self.save_manifest(manifest)
                self.recover()
                owner.update(state="READY", target_environment=None)
                atomic_bytes(self.owner_path, json_bytes(owner))
            return self.inspect()
        if owner["environment"] != current_env:
            raise RuntimeRefusal("WRITER_ENVIRONMENT_MISMATCH", "Maintenance must run in the current owner environment")
        with ShortLock(self.path / ".runtime.lock"):
            owner = json.loads(self.owner_path.read_bytes().decode("utf-8"))
            if operation == "recover":
                if owner["state"] not in ("BOOTSTRAP", "READY", "QUIESCED"):
                    raise RuntimeRefusal("HANDOFF_IN_PROGRESS", "Complete or cancel the explicit handoff first")
                if not self.manifest_path.exists():
                    backup = self.path / "runtime-manifest.recovery.json"
                    if backup.exists():
                        manifest = json.loads(backup.read_bytes().decode("utf-8"))
                        if manifest.get("project") != owner["project"]:
                            raise RuntimeRefusal("MANIFEST_RECOVERY_REQUIRED", "Recovery manifest belongs to a different project")
                        self.save_manifest(manifest)
                    else:
                        segments = list((self.path / "segments").glob("*.jsonl"))
                        if owner["state"] != "BOOTSTRAP" or any(p.stat().st_size for p in segments):
                            raise RuntimeRefusal("MANIFEST_RECOVERY_REQUIRED", "Preserve existing journal; restore its manifest before recovery")
                        manifest = dict(version=4, project=owner["project"], epoch=owner["epoch"], legacy=owner.get("bootstrap_legacy"),
                                        segments=[{"path": "segments/000001.jsonl", "limit": None}])
                        atomic_bytes(self.path / manifest["segments"][0]["path"], b"")
                        self.save_manifest(manifest)
                self.recover()
                if self.manifest().get("legacy") and ("readiness", "legacy") not in self.read():
                    raise RuntimeRefusal("MIGRATION_INCOMPLETE", "Resume migration from its frozen source before readiness")
                owner.update(state="READY", epoch=owner["epoch"] + 1)
            elif operation in ("quiesce", "handoff"):
                if owner["state"] != "READY":
                    raise RuntimeRefusal("OWNER_QUIESCED", "Owner is not ready")
                active = [v["data"] for (k, _), v in self.read().items() if k == "run" and v["data"]["status"] == "RUNNING" and v["data"]["deadline"] > time.time()]
                if active:
                    raise RuntimeRefusal("ACTIVE_EXECUTION", "Finish or expire active execution before handing off")
                if operation == "handoff" and (not target_environment or target_environment == current_env):
                    raise RuntimeRefusal("HANDOFF_SCOPE", "Name a different destination environment id")
                owner.update(state="HANDOFF" if operation == "handoff" else "QUIESCED", target_environment=target_environment)
            else:
                raise RuntimeRefusal("INVALID_MAINTENANCE", "Use recover, quiesce, handoff or accept")
            atomic_bytes(self.owner_path, json_bytes(owner))
        return {"ok": True, "owner": owner}

    @contextlib.contextmanager
    def lock(self):
        owner = self.owner(write=True)
        with ShortLock(self.path / ".runtime.lock"):
            current = self.owner(write=True)
            if owner["epoch"] != current["epoch"]:
                raise RuntimeRefusal("STALE_EPOCH", "Writer epoch changed")
            yield current

    def connect(self, readonly=False):
        if readonly:
            from urllib.parse import quote
            uri = "file:" + quote(str(self.db_path), safe="") if os.name == "nt" else self.db_path.as_uri()
            conn = sqlite3.connect(uri + "?mode=ro", uri=True)
        else:
            conn = sqlite3.connect(str(self.db_path))
            try:
                conn.execute("PRAGMA journal_mode=DELETE")
                conn.execute("PRAGMA synchronous=FULL")
                conn.executescript(SCHEMA)
                conn.execute("UPDATE schema_meta SET version=4")
            except Exception:
                conn.close()
                raise
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def manifest(self):
        try:
            return json.loads(self.manifest_path.read_bytes().decode("utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeRefusal("MANIFEST_RECOVERY_REQUIRED", "Runtime manifest is missing or invalid; preserve the journal and recover") from exc

    def save_manifest(self, manifest):
        raw = json_bytes(manifest)
        atomic_bytes(self.path / "runtime-manifest.recovery.json", raw)
        atomic_bytes(self.manifest_path, raw)

    def events(self, repair_tail=False):
        manifest, events = self.manifest(), []
        expected = 1
        changed = False
        for segment in manifest["segments"]:
            raw = (self.path / segment["path"]).read_bytes()
            if segment["limit"] is not None:
                raw = raw[:segment["limit"]]
            offset = 0
            for line in raw.splitlines(keepends=True):
                if not line.endswith(b"\n"):
                    if segment is not manifest["segments"][-1] or not repair_tail:
                        raise RuntimeRefusal("JOURNAL_INCOMPLETE_TAIL", "Incomplete journal tail; writer recovery required")
                    segment["limit"] = offset
                    changed = True
                    break
                try:
                    event = json.loads(line.decode("utf-8"))
                    checksum = event.pop("checksum")
                    if digest(event) != checksum or event["seq"] != expected or event["version"] != 4:
                        raise ValueError("checksum/version/sequence mismatch")
                    event["checksum"] = checksum
                except (UnicodeError, ValueError, KeyError) as exc:
                    raise RuntimeRefusal("JOURNAL_CORRUPTION", "Complete journal event is invalid; no events skipped") from exc
                events.append(event)
                expected += 1
                offset += len(line)
        if changed:
            item = {"path": f"segments/{len(manifest['segments']) + 1:06}.jsonl", "limit": None}
            atomic_bytes(self.path / item["path"], b"")
            manifest["segments"].append(item)
            self.save_manifest(manifest)
        return events

    @staticmethod
    def apply(conn, event):
        for action in event["actions"]:
            if action["op"] == "put":
                conn.execute("INSERT OR REPLACE INTO runtime_objects VALUES(?,?,?,?)",
                             (action["kind"], action["id"], action["revision"],
                              json_bytes(action["body"]).decode("utf-8")))
            elif action["op"] == "delete":
                conn.execute("DELETE FROM runtime_objects WHERE kind=? AND id=?", (action["kind"], action["id"]))
            else:
                raise RuntimeRefusal("UNKNOWN_EVENT_ACTION", "Unknown runtime event action")
        conn.execute("INSERT INTO runtime_events VALUES(?,?,?,?)",
                     (event["seq"], event["request_id"], event["payload_hash"], json_bytes(event).decode("utf-8")))

    def apply_effects(self, event):
        effects = event.get("effects", [])
        if not effects:
            return
        receipt = self.path / "effect-receipts" / (str(event["seq"]) + ".json")
        if receipt.exists():
            if json.loads(receipt.read_bytes()) != {"checksum": event["checksum"]}:
                raise RuntimeRefusal("EFFECT_RECEIPT_CORRUPTION", "Product effect receipt differs from the durable event")
            return
        from .paths import resolve_ref, contained
        root = getattr(self, "source_root", None)
        if root is None:
            raise RuntimeRefusal("SOURCE_ROOT_REQUIRED", "Recover product effects through the bound project engine")
        for effect in effects:
            path = resolve_ref(root, effect["path"])
            if contained(path, self.path) or contained(path, Path(root) / ".claude") or contained(path, Path(root) / ".git"):
                raise RuntimeRefusal("PRIVATE_INPUT_FORBIDDEN", "Journaled product effect targets private state")
            current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
            if current == effect["source_blob"]:
                continue  # Crash after installation, before its completion receipt.
            if current != effect["previous_sha256"]:
                raise RuntimeRefusal("RECOVERY_PRODUCT_CONFLICT", "Preserve changed product bytes; resolve the interrupted effect before continuing", path=effect["path"])
            atomic_bytes(path, self.blobs.get(effect["source_blob"]))
            self.checkpoint("after_product_effect")
        atomic_bytes(receipt, json_bytes({"checksum": event["checksum"]}))

    def recover(self):
        events = self.events(repair_tail=True)
        legacy = self.manifest().get("legacy")
        if legacy and not events and legacy.get("bootstrap_event_blob"):
            raw = self.blobs.get(legacy["bootstrap_event_blob"])
            event = json.loads(raw)
            checksum = event.pop("checksum")
            if digest(event) != checksum or event.get("seq") != 1:
                raise RuntimeRefusal("JOURNAL_CORRUPTION", "Frozen adoption event is invalid")
            event["checksum"] = checksum
            segment = self.path / self.manifest()["segments"][-1]["path"]
            if segment.stat().st_size:
                raise RuntimeRefusal("MIGRATION_INCOMPLETE", "Refuse to overwrite a nonempty adoption segment")
            atomic_bytes(segment, raw)
            events = [event]
        if legacy and not self.db_path.exists():
            from .legacy_v3 import replay
            journal = self.path / legacy["path"]
            if hashlib.sha256(journal.read_bytes()).hexdigest() != legacy["sha256"]:
                raise RuntimeRefusal("LEGACY_SOURCE_CHANGED", "Cannot recover missing projection from changed legacy bytes")
            temp = self.path / (".legacy-recover-" + uuid.uuid4().hex + ".db")
            try:
                restored = replay(journal, temp)
                restored.close()
                install_database(temp, self.db_path)
            finally:
                if temp.exists():
                    temp.unlink()
        conn = self.connect()
        try:
            applied = {r[0]: r[1] for r in conn.execute("SELECT seq,envelope FROM runtime_events")}
            if any(seq > len(events) for seq in applied):
                raise RuntimeRefusal("DATABASE_AHEAD", "Database contains unjournaled runtime events")
            for event in events:
                old = applied.get(event["seq"])
                if old:
                    if json.loads(old) != event:
                        raise RuntimeRefusal("DATABASE_DIVERGENCE", "Database event differs from journal")
                else:
                    self.apply_effects(event)
                    self.apply(conn, event)
            expected = {}
            for event in events:
                for action in event["actions"]:
                    key = action["kind"], action["id"]
                    if action["op"] == "delete":
                        expected.pop(key, None)
                    else:
                        expected[key] = {"revision": action["revision"], "data": action["body"]}
            actual = {(k, i): {"revision": r, "data": json.loads(body)}
                      for k, i, r, body in conn.execute("SELECT kind,id,revision,body FROM runtime_objects")}
            if expected != actual:
                raise RuntimeRefusal("DATABASE_DIVERGENCE", "Unjournaled projection changes require rebuild before writing")
            conn.commit()
        finally:
            conn.close()

    def inspect(self):
        owner = self.owner()
        manifest = self.manifest()
        if manifest.get("project") != owner["project"]:
            raise RuntimeRefusal("MANIFEST_RECOVERY_REQUIRED", "Owner and manifest project identities differ")
        if not self.db_path.exists():
            raise RuntimeRefusal("PROJECTION_MISSING", "Existing ledger needs maintenance recover or rebuild, not initialization")
        with contextlib.closing(self.connect(readonly=True)) as conn:
            return {"ok": True, "schema": 4, "owner": owner,
                    "seq": conn.execute("SELECT COALESCE(MAX(seq),0) FROM runtime_events").fetchone()[0]}

    def read(self):
        with contextlib.closing(self.connect(readonly=True)) as conn:
            return {(r[0], r[1]): dict(revision=r[2], data=json.loads(r[3]))
                    for r in conn.execute("SELECT kind,id,revision,body FROM runtime_objects")}

    def receipt(self, request_id):
        with contextlib.closing(self.connect(readonly=True)) as conn:
            row = conn.execute("SELECT envelope FROM runtime_events WHERE request_id=?", (request_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def transact(self, request, actor, callback):
        rid = request.get("request_id")
        if not isinstance(rid, str) or not rid or len(rid) > 200:
            raise RuntimeRefusal("INVALID_REQUEST_ID", "Every mutation requires a stable request_id")
        payload_hash = digest(request)
        with self.lock() as owner:
            self.recover()
            old = self.receipt(rid)
            if old:
                if old["payload_hash"] != payload_hash or old["actor"] != actor:
                    raise RuntimeRefusal("REQUEST_CONFLICT", "Request id was used with different content or identity")
                return dict(old["result"], committed=True, request_id=rid, seq=old["seq"], reused=True)
            before = self.read()
            working = copy.deepcopy(before)
            result = callback(working)
            actions = []
            effects = []
            for key in sorted(set(before) | set(working)):
                if key not in working:
                    actions.append(dict(op="delete", kind=key[0], id=key[1]))
                elif before.get(key) != working[key]:
                    revision = before.get(key, {}).get("revision", 0) + 1
                    actions.append(dict(op="put", kind=key[0], id=key[1], revision=revision,
                                        body=working[key]["data"]))
                    body = working[key]["data"]
                    if key not in before and body.get("install_effect"):
                        effects.append({k: body[k] for k in ("path", "source_blob", "previous_sha256")})
            seq = self.inspect()["seq"] + 1
            event = dict(version=4, seq=seq, request_id=rid, payload_hash=payload_hash,
                         actor=actor, epoch=owner["epoch"], at=time.time(), request=request, actions=actions, effects=effects, result=result)
            event["checksum"] = digest(event)
            conn = self.connect()
            durable = False
            try:
                self.apply(conn, event)
                self.checkpoint("before_append")
                segment = self.path / self.manifest()["segments"][-1]["path"]
                with open(segment, "ab") as stream:
                    stream.write(json_bytes(event))
                    stream.flush()
                    os.fsync(stream.fileno())
                durable = True
                self.checkpoint("after_fsync")
                self.apply_effects(event)
                conn.commit()
                self.checkpoint("after_commit")
            except Exception as exc:
                conn.rollback()
                if durable:
                    raise RuntimeRefusal("COMMIT_DURABLE_RECOVERY_REQUIRED", "Journal committed; recover the same request receipt",
                                         request_id=rid) from exc
                raise
            finally:
                conn.close()
            return dict(result, committed=True, request_id=rid, seq=seq,
                        reused=result.get("reused", False), request_reused=False)

    def rebuild(self):
        with self.lock():
            events = self.events(repair_tail=True)
            temp = self.db_path.with_name(".rebuild-" + uuid.uuid4().hex + ".db")
            try:
                legacy = self.manifest().get("legacy")
                if legacy:
                    from .legacy_v3 import replay
                    journal = self.path / legacy["path"]
                    if hashlib.sha256(journal.read_bytes()).hexdigest() != legacy["sha256"]:
                        raise RuntimeRefusal("LEGACY_SOURCE_CHANGED", "Frozen legacy journal changed")
                    conn = replay(journal, temp)
                else:
                    conn = sqlite3.connect(str(temp))
                try:
                    conn.executescript(SCHEMA)
                    conn.execute("UPDATE schema_meta SET version=4")
                    # Preserve legacy projection, if any, via its frozen event dispatcher.
                    for event in events:
                        self.apply_effects(event)
                        self.apply(conn, event)
                    conn.commit()
                finally:
                    conn.close()
                install_database(temp, self.db_path)
            finally:
                if temp.exists():
                    temp.unlink()
            return {"ok": True, "events": len(events)}

    def doctor(self):
        events = self.events()
        for event in events:
            if event.get("effects"):
                receipt = self.path / "effect-receipts" / (str(event["seq"]) + ".json")
                if not receipt.exists() or json.loads(receipt.read_bytes()) != {"checksum": event["checksum"]}:
                    raise RuntimeRefusal("EFFECT_RECOVERY_REQUIRED", "Durable product effects need completion recovery")
        state = {}
        for event in events:
            for action in event["actions"]:
                key = action["kind"], action["id"]
                if action["op"] == "delete":
                    state.pop(key, None)
                else:
                    state[key] = {"revision": action["revision"], "data": action["body"]}
        if state != self.read():
            raise RuntimeRefusal("DATABASE_DIVERGENCE", "Projection does not match complete replay")
        checked = set()
        for item in state.values():
            for key, value in item["data"].items():
                if key.endswith("_blob") and value:
                    self.blobs.get(value)
                    checked.add(value)
        return {"ok": True, "storage": "clean", "events": len(events), "blobs_checked": len(checked)}
