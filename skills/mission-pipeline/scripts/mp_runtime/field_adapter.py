"""Supported replacement for field adapters: structured engine calls and fenced views."""
import argparse
import contextlib
import json
import sqlite3
import sys
import time
from pathlib import Path

from .engine import Engine
from .process import RuntimeRefusal, json_bytes, read_json_bytes
from .storage import atomic_bytes, digest
from .workflow import Actor


def readonly_query(store, sql, parameters=()):
    """SQLite authorizer enforces read-only queries; no DDL or implicit migration."""
    with contextlib.closing(store.connect(readonly=True)) as conn:
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
        conn.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
        try:
            cursor = conn.execute(sql, parameters)
            return {"columns": [x[0] for x in cursor.description], "rows": cursor.fetchall()}
        except sqlite3.DatabaseError as exc:
            raise RuntimeRefusal("READ_QUERY_REJECTED", "Query is not an allowed read-only statement") from exc


def snapshot(engine):
    # One read transaction keeps seq and rendered rows from the same committed projection.
    with contextlib.closing(engine.store.connect(readonly=True)) as conn:
        conn.execute("BEGIN")
        seq = conn.execute("SELECT COALESCE(MAX(seq),0) FROM runtime_events").fetchone()[0]
        rows = [{"kind": k, "id": i, "revision": r, "body": json.loads(b)}
                for k, i, r, b in conn.execute("SELECT kind,id,revision,body FROM runtime_objects ORDER BY kind,id")]
    return {"epoch": engine.store.owner()["epoch"], "seq": seq, "objects": rows}


def publish(engine, captured=None):
    captured = captured or snapshot(engine)
    raw = json_bytes(captured)  # Render outside the short publication lock.
    with engine.store.lock() as owner:
        current = engine.store.inspect()
        if captured["epoch"] != owner["epoch"] or captured["seq"] != current["seq"]:
            raise RuntimeRefusal("VIEW_STALE", "Projection changed while rendering; recapture before publication")
        target = engine.store.path / "views" / "runtime.json"
        if target.exists():
            old = read_json_bytes(target.read_bytes())
            if (old["epoch"], old["seq"]) > (captured["epoch"], captured["seq"]):
                raise RuntimeRefusal("VIEW_STALE", "An older renderer cannot overwrite a newer published view")
        atomic_bytes(target, raw)
    return {"ok": True, "path": str(target), "seq": captured["seq"], "sha256": digest(captured)}


def invoke(engine, request, refresh=True):
    for attempt in range(3):
        try:
            result = engine.handle(request)
            break
        except RuntimeRefusal as exc:
            if exc.code != "BUSY_RETRYABLE" or attempt == 2:
                raise
            time.sleep(0.02 * (attempt + 1))
    if refresh and result.get("committed"):
        try:
            result["view"] = publish(engine)
        except (RuntimeRefusal, OSError) as exc:
            result.update(view_stale=True, view_error=getattr(exc, "code", "IO_ERROR"))
    return result


def relay(engine, mission):
    state = snapshot(engine)
    objects = [row for row in state["objects"] if row["body"].get("mission") == mission or row["body"].get("id") == mission]
    from .contracts import required_records
    records = {(row["kind"], row["id"]): {"data": row["body"]} for row in state["objects"]}
    selected = {(row["kind"], row["id"]) for row in objects}
    for kind, value in required_records(records, mission):
        if (kind, value["id"]) not in selected:
            objects.append({"kind": kind, "id": value["id"], "body": value})
            selected.add((kind, value["id"]))
    body = {"mission": mission, "epoch": state["epoch"], "seq": state["seq"], "objects": objects}
    sha = engine.store.blobs.put(json_bytes(body))
    return {"ok": True, "mission": mission, "relay_blob": sha, "seq": state["seq"]}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--actor", default="pm")
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args(argv)
    try:
        if args.actor == "controller":
            raise RuntimeRefusal("ROLE_FORBIDDEN", "controller is the executor's internal identity")
        engine = Engine(args.root, Actor(args.actor, "local-adapter:" + args.actor))
        result = invoke(engine, read_json_bytes(Path(args.request_file).read_bytes()))
    except RuntimeRefusal as exc:
        sys.stdout.buffer.write(json_bytes(exc.body()))
        return 3
    sys.stdout.buffer.write(json_bytes(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
