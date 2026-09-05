#!/usr/bin/env python3
"""M4 gate — migration (new at v1.1.0).

    a v1.0.0 ledger — a v1 SQLite schema and a journal of v1 actions — upgrades
    with `mp migrate`, replays whole, and then carries v1.1 events alongside its
    v1 ones in the same journal.

The journal is authoritative and physically unrewritable: every v1 action's
apply function must live forever, or a released deployment's disaster recovery
dies the day it upgrades. This gate builds a mission with the deprecated v1
verbs, hand-writes the three v1 journal lines the v1.1 CLI no longer emits
(`artifact.seal`, `charter.amend`, `gate.record` — retired, aliased and
re-aimed respectively), downgrades the DB to the v1.0.0 schema below, and then
puts the whole thing through migrate / rebuild / doctor.

V1_SCHEMA is the v1.0.0 DDL verbatim (`git show 3d24410:.../mp`). It is a
fixture, not a copy to keep in sync: it is what shipped.

Run: python3 tests/m4_migrate.py
"""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MP = str(REPO / "skills" / "mission-pipeline" / "scripts" / "mp")
sys.dont_write_bytecode = True  # no __pycache__ in the working tree
sys.path.insert(0, str(REPO / "tests" / "fixtures"))
from docs import write as fixture  # noqa: E402

M = "Week01-V1"
FAILS = []
ENV = {}
TMP = None

V1_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, branch TEXT,
  started TEXT, status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed')),
  closed_at TEXT, charter_version INTEGER, round_cap INTEGER NOT NULL DEFAULT 3);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  category TEXT NOT NULL, key TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL,
  path TEXT NOT NULL, sha256 TEXT, sealed_at TEXT, author_role TEXT,
  created_at TEXT,
  UNIQUE (mission, category, key, round, version));
CREATE TABLE IF NOT EXISTS edges (
  from_artifact INTEGER NOT NULL REFERENCES artifacts(id),
  to_artifact INTEGER NOT NULL REFERENCES artifacts(id),
  kind TEXT NOT NULL CHECK (kind IN ('derives-from','cites','carries')));
CREATE TABLE IF NOT EXISTS rounds (
  mission INTEGER NOT NULL REFERENCES missions(id), task TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1), opened TEXT NOT NULL, closed TEXT,
  UNIQUE (mission, task, n));
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  task TEXT, artifact INTEGER REFERENCES artifacts(id),
  kind TEXT NOT NULL, by_role TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  task TEXT, source_artifact INTEGER REFERENCES artifacts(id),
  text_verbatim TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('out-of-frame','noticed-not-fixed')),
  raised_at TEXT NOT NULL, disposition TEXT, disposed_at TEXT,
  disposed_in INTEGER REFERENCES artifacts(id));
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY, artifact INTEGER NOT NULL REFERENCES artifacts(id),
  criterion TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('R','F','D','X')),
  anchor TEXT NOT NULL, cmd TEXT, output_sha TEXT,
  fingerprint_id INTEGER REFERENCES fingerprints(id));
CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY, commit_sha TEXT, dirty INTEGER NOT NULL,
  tree_hash TEXT, taken_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS charter (
  mission INTEGER NOT NULL REFERENCES missions(id), version INTEGER NOT NULL,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, amended_by TEXT,
  verbatim_quote TEXT, readback_ref TEXT, at TEXT NOT NULL,
  UNIQUE (mission, version));
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, origin TEXT,
  verified_by TEXT, ratified_at TEXT, retired_at TEXT);
CREATE TABLE IF NOT EXISTS gates (
  id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  scope TEXT NOT NULL, cmd TEXT NOT NULL, log_path TEXT, log_sha TEXT,
  fingerprint_id INTEGER REFERENCES fingerprints(id),
  result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, payload_json TEXT NOT NULL);
"""

# the tables a v1.0.0 mp.db carried, in v1.0.0 column order
V1_TABLES = {
    "schema_meta": "version",
    "missions": "id,name,branch,started,status,closed_at,charter_version,round_cap",
    "artifacts": "id,mission,category,key,round,version,path,sha256,sealed_at,"
                 "author_role,created_at",
    "edges": "from_artifact,to_artifact,kind",
    "rounds": "mission,task,n,opened,closed",
    "verdicts": "id,mission,task,artifact,kind,by_role,at",
    "flags": "id,mission,task,source_artifact,text_verbatim,kind,raised_at,"
             "disposition,disposed_at,disposed_in",
    "evidence": "id,artifact,criterion,type,anchor,cmd,output_sha,fingerprint_id",
    "fingerprints": "id,commit_sha,dirty,tree_hash,taken_at",
    "charter": "mission,version,path,sha256,amended_by,verbatim_quote,"
               "readback_ref,at",
    "contracts": "id,text,origin,verified_by,ratified_at,retired_at",
    "gates": "id,mission,scope,cmd,log_path,log_sha,fingerprint_id,result,at",
    "events": "seq,at,actor,action,payload_json",
}

def check(name, cond, detail=""):
    print(("  ok  " if cond else "  FAIL") + f" {name}"
          + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)

def run(args, rc=0):
    r = subprocess.run([sys.executable, MP, "--json"] + args,
                       capture_output=True, text=True, env=ENV)
    body = {}
    if r.stdout.strip():
        try:
            body = json.loads(r.stdout.strip().splitlines()[-1])
        except json.JSONDecodeError:
            pass
    if r.returncode != rc:
        check(f"`mp {' '.join(args)}` rc={rc}", False,
              f"got rc={r.returncode} out={r.stdout.strip()[:300]}"
              f" err={r.stderr.strip()[:300]}")
    return r.returncode, body

def ledger():
    return TMP / ".claude" / "mission-pipeline" / "ledger"

def journal():
    return [json.loads(x) for x in
            (ledger() / "events.jsonl").read_text(encoding="utf-8").splitlines()
            if x.strip()]

def append_v1_events(events):
    """Write journal lines exactly as v1.0.0 wrote them. The DB is left behind
    on purpose: `mp rebuild` is what has to catch up, which is the whole point."""
    seq = journal()[-1]["seq"]
    with open(ledger() / "events.jsonl", "a", encoding="utf-8") as f:
        for action, payload in events:
            seq += 1
            f.write(json.dumps({"seq": seq, "at": "2026-08-31T12:00:00Z",
                                "actor": "v1-era", "action": action,
                                "result": "OK", "payload": payload},
                               ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")) + "\n")

def downgrade_to_v1():
    """Rewrite mp.db as a v1.0.0 database holding exactly the same rows."""
    src = sqlite3.connect(str(ledger() / "mp.db"))
    rows = {t: src.execute(f"SELECT {cols} FROM {t}").fetchall()
            for t, cols in V1_TABLES.items()}
    src.close()
    (ledger() / "mp.db").unlink()
    db = sqlite3.connect(str(ledger() / "mp.db"))
    db.executescript(V1_SCHEMA)
    for t, cols in V1_TABLES.items():
        n = len(cols.split(","))
        db.executemany(f"INSERT INTO {t} ({cols}) VALUES ({','.join('?' * n)})",
                       rows[t])
    db.execute("UPDATE schema_meta SET version=1")
    db.commit()
    db.close()

def sha256_file(p):
    h = hashlib.sha256()
    h.update(Path(p).read_bytes())
    return h.hexdigest()

# ---------------------------------------------------------------- the gate

def main():
    global TMP, ENV
    TMP = Path(tempfile.mkdtemp(prefix="mp-m4-"))
    ENV = dict(os.environ, MP_ROOT=str(TMP), MP_ACTOR="v1-era")
    g = lambda *a: subprocess.run(["git", "-C", str(TMP)] + list(a),
                                  capture_output=True, text=True)
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (TMP / "src.txt").write_text("hello\n")
    g("add", "-A")
    g("commit", "-qm", "init")

    print("== a mission built the v1.0.0 way, with the deprecated verbs")
    run(["init"])
    run(["mission", "claim", M, "--cap", "3"])
    rel = f".claude/mission-pipeline/ledger/{M}/DevReport_T1_2026-08-31_v01.md"
    fixture(TMP, rel, "devreport", mission=M, key="T1", round=1, version=1,
            derives="none", summary="the v1 way", runs="| None | — | — |",
            noticed="- None", relay="")
    rc, b = run(["artifact", "new", "--mission", M, "--category", "DevReport",
                 "--key", "T1", "--round", "1", "--version", "1", "--path", rel,
                 "--author-role", "constructor"])
    dev = b["payload"]["id"]
    spec_rel = f".claude/mission-pipeline/ledger/{M}/TaskSpec_T1_2026-08-31_v01.md"
    fixture(TMP, spec_rel, "taskspec", mission=M, key="T1", version=1, wave="W1",
            recovers="", touches="no", derives="none", objective="the v1 way",
            ac1="it works", out_of_scope="- the retry path")
    rc, b = run(["artifact", "new", "--mission", M, "--category", "TaskSpec",
                 "--key", "T1", "--round", "0", "--version", "1", "--path",
                 spec_rel, "--author-role", "architect"])
    spec = b["payload"]["id"]
    run(["edge", "add", "--from", str(dev), "--to", str(spec),
         "--kind", "derives-from"])
    for n in (1, 2):
        run(["round", "open", "--mission", M, "--task", "T1", "--n", str(n)])
        run(["round", "close", "--mission", M, "--task", "T1", "--n", str(n)])
    run(["verdict", "record", "--mission", M, "--task", "T1", "--artifact",
         str(dev), "--kind", "PASS", "--by", "crititor"])
    rc, b = run(["fingerprint", "take"])
    fp = b["payload"]["id"]
    run(["evidence", "add", "--artifact", str(dev), "--criterion", "AC1",
         "--type", "R", "--anchor", "python3 -m pytest -q", "--cmd",
         "python3 -m pytest -q", "--output-sha", "ab" * 32,
         "--fingerprint", str(fp)])
    rc, b = run(["flag", "add", "--mission", M, "--task", "T1", "--kind",
                 "out-of-frame", "--text", "the retry path is untested"])
    flag = b["payload"]["id"]
    run(["flag", "dispose", str(flag), "--disposition",
         "accepted risk — lands in Week02"])
    ch_rel = f".claude/mission-pipeline/ledger/{M}/Charter_{M}_2026-08-31_v01.md"
    fixture(TMP, ch_rel, "charter", mission=M, version=1, derives="none",
            goal="ship it", prohibitions="- never weaken the gate",
            amendments="| v1 | 2026-08-31 | (initial seal) | — |")
    run(["charter", "seal", "--mission", M, "--path", ch_rel])
    run(["contract", "add", "--text", "never weaken the gate", "--origin",
         f"Charter v1 prohibition ({M})", "--verified-by", "crititor",
         "--ratified", "2026-08-31"])
    (TMP / "gate.log").write_text("42 passed\n")
    v1_actions = {e["action"] for e in journal()}
    check("the v1 verbs still work, one journal event each",
          {"mission.claim", "artifact.new", "edge.add", "round.open",
           "round.close", "verdict.record", "evidence.add", "flag.add",
           "flag.dispose", "charter.seal", "contract.add",
           "fingerprint.take"} <= v1_actions, str(sorted(v1_actions)))

    print("== the three v1 journal lines the v1.1 CLI no longer emits")
    mid = 1
    append_v1_events([
        ("artifact.seal", {"id": spec, "sha256": sha256_file(TMP / spec_rel),
                           "sealed_at": "2026-08-31T12:00:00Z"}),
        ("charter.amend", {"mission": mid, "version": 2, "path": ch_rel,
                           "sha256": sha256_file(TMP / ch_rel),
                           "amended_by": "principal",
                           "quote": "yes — widen T1 to cover the retry path",
                           "readback": "readback-1",
                           "at": "2026-08-31T12:00:00Z"}),
        ("gate.record", {"id": 1, "mission": mid, "scope": "closing",
                         "cmd": "python3 -m pytest -q", "log_path": "gate.log",
                         "log_sha": sha256_file(TMP / "gate.log"),
                         "fingerprint": fp, "result": "green",
                         "at": "2026-08-31T12:00:00Z"}),
    ])

    print("== downgrade to the v1.0.0 schema, and meet the wall")
    downgrade_to_v1()
    db = sqlite3.connect(str(ledger() / "mp.db"))
    tables = {r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    ver = db.execute("SELECT version FROM schema_meta").fetchone()[0]
    db.close()
    check("the DB is a v1 database again",
          ver == 1 and not (tables & {"runs", "waves", "relay",
                                      "supersessions"}), str(sorted(tables)))
    rc, b = run(["doctor"], rc=1)
    check("v1.1 refuses to touch a v1 DB, and names the fix",
          "run `mp migrate`" in (b.get("error") or ""), str(b)[:200])

    print("== migrate")
    rc, b = run(["migrate"])
    check("migrate reports what it added",
          b.get("ok") is True and b.get("from") == 1 and b.get("version") == 2
          and set(b["tables"]) == {"runs", "waves", "relay", "supersessions"}
          and "artifacts.superseded_by" in b["added"], str(b)[:400])
    rc, b = run(["migrate"])
    check("migrate is idempotent", b.get("already") is True)

    print("== the v1 journal replays whole into the v1.1 schema")
    rc, b = run(["rebuild"])
    check("rebuild replays every line, skipping none",
          b.get("ok") is True and not b.get("replay_skips"), str(b)[:300])
    rc, b = run(["doctor"])
    check("doctor CLEAN — the migrated DB equals the replayed journal",
          rc == 0 and b.get("ok") is True, str(b.get("findings"))[:400])
    db = sqlite3.connect(str(ledger() / "mp.db"))
    ch = db.execute("SELECT version, verbatim_quote FROM charter"
                    " ORDER BY version").fetchall()
    gates = db.execute("SELECT scope, result FROM gates").fetchall()
    sealed = db.execute("SELECT sealed_at FROM artifacts WHERE id=?",
                        (spec,)).fetchone()[0]
    db.close()
    check("the retired `charter.amend` still applies on replay",
          [c[0] for c in ch] == [1, 2]
          and ch[1][1] == "yes — widen T1 to cover the retry path", str(ch))
    check("the aliased `gate.record` still applies on replay",
          gates == [("closing", "green")], str(gates))
    check("the retired `artifact.seal` still applies on replay",
          sealed == "2026-08-31T12:00:00Z", str(sealed))

    print("== v1 and v1.1 events coexist in one journal")
    run(["wave", "open", "W1", "--mission", M, "--tasks", "T2"])
    (TMP / "suite.log").write_text("43 passed\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q", "--log",
                 "suite.log"])
    run1 = b["id"]
    rel2 = f".claude/mission-pipeline/ledger/{M}/DevReport_T2_r1_v01.md"
    fixture(TMP, rel2, "devreport", mission=M, key="T2", round=1, version=1,
            derives=f"artifact:{spec}", summary="the v1.1 way",
            runs=f"| run:{run1} | python3 -m pytest -q | 43 passed |",
            noticed="- None", relay="")
    rc, b = run(["seal", rel2])
    check("a v1.1 seal lands on top of a migrated v1 ledger",
          b.get("ok") is True and [r["n"] for r in b["rounds"]] == [1],
          str(b)[:300])
    print("== lint's seal-parse rule binds the v1.1 seal, never the v1-era one")
    rc, b = run(["lint", "--mission", M])
    check("a migrated ledger lints CLEAN — the v1-era spec sealed by"
          " `artifact.seal` is not asked for sections it never had",
          rc == 0 and b.get("ok") is True
          and not [f for f in b.get("findings", []) if f["rule"] == "seal-parse"],
          str(b.get("findings"))[:400])
    intact = (TMP / rel2).read_text()
    (TMP / rel2).write_text(intact.replace("## Runs", "## Was runs", 1))
    rc, b = run(["lint", "--mission", M], rc=2)
    check("a v1.1-sealed document that lost a required section is still caught",
          any(f["rule"] == "seal-parse" and "## runs" in f["message"]
              for f in b.get("findings", [])), str(b.get("findings"))[:400])
    (TMP / rel2).write_text(intact)
    rc, b = run(["lint", "--mission", M])
    check("restored, it lints CLEAN again", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])

    rc, b = run(["supersede", f"artifact:{dev}", "--by", "reality",
                 "--reason", "the v1-era report was rewritten in T2"])
    check("the v1.1 repair verb works on a v1-era row", b.get("ok") is True)
    acts = {e["action"] for e in journal()}
    check("old and new actions sit in the same journal",
          {"artifact.new", "evidence.add", "charter.amend", "gate.record"}
          <= acts and {"artifact.sealed", "run.record", "wave.open",
                       "supersede"} <= acts, str(sorted(acts)))
    seqs = [e["seq"] for e in journal()]
    check("the journal is still one contiguous sequence",
          seqs == list(range(1, len(seqs) + 1)))

    print("== and the migrated ledger stays healthy")
    rc, b = run(["doctor"])
    check("doctor CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])
    rc, b = run(["rebuild"])
    check("rebuild ok", b.get("ok") is True and not b.get("replay_skips"))
    rc, b = run(["doctor"])
    check("doctor CLEAN after rebuild", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])
    rc, b = run(["metrics", "--match", "Week01*"])
    check("metrics reads the mixed state",
          b["missions"][M]["tasks"] == 2, str(b.get("missions"))[:300])
    rc, b = run(["worklist", "--mission", M])
    check("the worklist notices what now depends on the superseded v1 row",
          any(i["kind"] == "verdict-on-superseded" for i in b["items"]),
          str(b.get("items"))[:400])

    print()
    if FAILS:
        print(f"M4 MIGRATE: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("M4 MIGRATE GATE PASSED — a v1.0.0 ledger upgrades in place, its"
          " journal replays whole, and v1 and v1.1 events coexist")

if __name__ == "__main__":
    main()
