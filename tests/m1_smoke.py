#!/usr/bin/env python3
"""M1 smoke test — the live state machine end to end, through the DEPRECATED
v1.0 verbs, which must keep working for compatibility and replay.

Exercises: init, atomic mission claim, artifact seal immutability, the round cap
(invariant 4), flag disposal blocking close (invariant 11), R-evidence needing a
fingerprint, charter seal, the RETIRED `charter amend` and the re-issue that
replaces it, gate log binding, REFUSED journaling, rebuild, and doctor's three
detectors (clean / DB written outside the write path / sealed file modified).

Run: python3 tests/m1_smoke.py
"""
import json
import os
os.environ['MP_COMPAT_V3'] = '1'  # Explicit released-schema regression; v4 ledgers reject this path.
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

FAILS = []

def check(name, cond, detail=""):
    print(("  ok  " if cond else "  FAIL") + f" {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)

def run(args, rc=0, env=None):
    r = subprocess.run([sys.executable, MP, "--json"] + args,
                       capture_output=True, text=True, encoding="utf-8", env=env)
    body = {}
    if r.stdout.strip():
        try:
            body = json.loads(r.stdout.strip().splitlines()[-1])
        except json.JSONDecodeError:
            pass
    if r.returncode != rc:
        check(f"`mp {' '.join(args)}` rc={rc}", False,
              f"got rc={r.returncode} out={r.stdout.strip()[:200]} err={r.stderr.strip()[:200]}")
    return r.returncode, body

def main():
    tmp = Path(tempfile.mkdtemp(prefix="mp-smoke-"))
    env = dict(os.environ, MP_ROOT=str(tmp), MP_ACTOR="smoke")
    g = lambda *a: subprocess.run(["git", "-C", str(tmp)] + list(a),
                                  capture_output=True, text=True, encoding="utf-8")
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (tmp / "src.txt").write_text("hello\n")
    g("add", "-A")
    g("commit", "-qm", "init")

    print("== init & claim")
    rc, b = run(["init"], env=env)
    check("init ok", b.get("ok") is True)
    rc, b = run(["mission", "claim", "Week01-Smoke", "--cap", "3"], env=env)
    check("claim ok", b.get("ok") is True)
    rc, b = run(["mission", "claim", "Week01-Smoke"], rc=3, env=env)
    check("duplicate claim REFUSED", b.get("refused") is True)

    print("== artifact + seal immutability")
    ledger = tmp / ".claude" / "mission-pipeline" / "ledger"
    art = ledger / "Week01-Smoke" / "constructor"
    art.mkdir(parents=True)
    f = art / "DevReport_T1_2026-08-31_v01.md"
    fixture(tmp, f.relative_to(tmp), "devreport", mission="Week01-Smoke",
            key="T1", round=1, version=1, derives="none",
            summary="the first cut", runs="| None | — | — |",
            noticed="- None", relay="")
    rel = str(f.relative_to(tmp))
    rc, b = run(["artifact", "new", "--mission", "Week01-Smoke", "--category",
                 "DevReport", "--key", "T1", "--round", "1", "--version", "1",
                 "--path", rel, "--author-role", "constructor"], env=env)
    aid = b["payload"]["id"]
    check("artifact new ok", b.get("ok") is True)
    rc, b = run(["artifact", "seal", str(aid)], env=env)
    check("seal ok", b.get("ok") is True)
    rc, b = run(["artifact", "seal", str(aid)], rc=3, env=env)
    check("re-seal REFUSED (versions immutable)", b.get("refused") is True)
    rc, b = run(["artifact", "new", "--mission", "Week01-Smoke", "--category",
                 "DevReport", "--key", "T1", "--round", "1", "--version", "1",
                 "--path", rel], rc=3, env=env)
    check("same version twice REFUSED", b.get("refused") is True)

    print("== round cap (invariant 4)")
    # T9 rather than T1: sealing the T1 DevReport already DERIVED T1's round 1
    # from its header, which is the point of v1.1 — the rounds row no longer
    # depends on anyone remembering the ceremony.
    for n in (1, 2, 3):
        rc, b = run(["round", "open", "--mission", "Week01-Smoke", "--task",
                     "T9", "--n", str(n)], env=env)
        check(f"round {n} opens", b.get("ok") is True)
        run(["round", "close", "--mission", "Week01-Smoke", "--task", "T9",
             "--n", str(n)], env=env)
    rc, b = run(["round", "open", "--mission", "Week01-Smoke", "--task", "T9",
                 "--n", "4"], rc=3, env=env)
    check("round 4 REFUSED at cap", b.get("refused") is True
          and "cap" in b.get("reason", ""))

    print("== flags block close (invariant 11)")
    rc, b = run(["flag", "add", "--mission", "Week01-Smoke", "--task", "T1",
                 "--kind", "out-of-frame", "--text",
                 "evidence identity is asserted, never verified"], env=env)
    fid = b["payload"]["id"]
    rc, b = run(["mission", "close", "Week01-Smoke"], rc=3, env=env)
    check("close REFUSED while flag undisposed", b.get("refused") is True)
    rc, b = run(["flag", "dispose", str(fid), "--disposition",
                 "accepted risk — identity check lands in T2"], env=env)
    check("dispose ok", b.get("ok") is True)
    rc, b = run(["mission", "close", "Week01-Smoke"], env=env)
    check("close ok after disposal", b.get("ok") is True)

    print("== evidence law hooks + fingerprint")
    rc, b = run(["evidence", "add", "--artifact", str(aid), "--criterion", "AC1",
                 "--type", "R", "--anchor", "pytest -q", "--output-sha", "x"],
                rc=3, env=env)
    check("R without fingerprint REFUSED", b.get("refused") is True)
    rc, b = run(["fingerprint", "take"], env=env)
    fpid = b["payload"]["id"]
    check("fingerprint ok", b.get("ok") is True and b["payload"]["dirty"] == 0)
    rc, b = run(["evidence", "add", "--artifact", str(aid), "--criterion", "AC1",
                 "--type", "R", "--anchor", "pytest -q", "--output-sha", "abc",
                 "--fingerprint", str(fpid)], env=env)
    check("R with fingerprint ok", b.get("ok") is True)

    print("== charter + gate")
    ch = ledger / "Week01-Smoke" / "Charter_Week01-Smoke_2026-08-31_v01.md"
    fixture(tmp, ch.relative_to(tmp), "charter", mission="Week01-Smoke",
            version=1, derives="none", goal="ship the loader",
            prohibitions="- never weaken the gate",
            amendments="| v1 | 2026-08-31 | (initial seal) | — |")
    rc, b = run(["charter", "seal", "--mission", "Week01-Smoke", "--path",
                 str(ch.relative_to(tmp))], env=env)
    check("charter seal ok", b.get("ok") is True)
    rc, b = run(["charter", "amend", "--mission", "Week01-Smoke", "--path",
                 str(ch.relative_to(tmp)), "--quote", "yes, include T9",
                 "--readback", "readback-1"], rc=3, env=env)
    check("charter amend REFUSED — a Charter is re-issued, never edited",
          b.get("refused") is True and "retired" in b.get("reason", "")
          and "version: 2" in b.get("reason", ""), b.get("reason", ""))

    print("== charter re-issue: a new file, a new version, the same identity")
    ch2 = ledger / "Week01-Smoke" / "Charter_Week01-Smoke_2026-08-31_v02.md"
    fixture(tmp, ch2.relative_to(tmp), "charter", mission="Week01-Smoke",
            version=2, derives="none", goal="ship the loader",
            prohibitions="- never weaken the gate",
            amendments="| v1 | 2026-08-31 | (initial seal) | — |\n"
                       "| v2 | 2026-08-31 | yes, include T9 | readback-1 |")
    rc, b = run(["seal", str(ch2.relative_to(tmp))], env=env)
    check("charter v2 sealed by re-issue",
          b.get("ok") is True and b["charter"]["version"] == 2
          and b["charter"]["quote"] == "yes, include T9", str(b)[:300])
    ch3 = ledger / "Week01-Smoke" / "Charter_Week01-Smoke_2026-08-31_v03.md"
    fixture(tmp, ch3.relative_to(tmp), "charter", mission="Week01-Smoke",
            version=3, derives="none", goal="ship the loader",
            prohibitions="- never weaken the gate",
            amendments="| v1 | 2026-08-31 | (initial seal) | — |\n"
                       "| v2 | 2026-08-31 | yes, include T9 | readback-1 |")
    rc, b = run(["seal", str(ch3.relative_to(tmp))], rc=3, env=env)
    check("a v3 with no amendment row of its own is REFUSED",
          b.get("refused") is True
          and "charter-amendment" in b.get("reason", ""), b.get("reason", ""))
    rc, b = run(["gate", "record", "--mission", "Week01-Smoke", "--scope",
                 "closing", "--cmd", "pytest", "--log", "no/such.log",
                 "--result", "green"], rc=3, env=env)
    check("gate with missing log REFUSED", b.get("refused") is True)
    log = tmp / "gate.log"
    log.write_text("120 passed\n")
    rc, b = run(["gate", "record", "--mission", "Week01-Smoke", "--scope",
                 "closing", "--cmd", "pytest", "--log", "gate.log",
                 "--result", "green"], env=env)
    check("gate with real log ok — it is a run now",
          b.get("ok") is True and b.get("output_sha") and b.get("tree_hash"),
          str(b)[:300])
    rc, b2 = run(["gate", "record", "--mission", "Week01-Smoke", "--scope",
                  "closing", "--cmd", "pytest", "--log", "gate.log",
                  "--result", "green"], env=env)
    check("the same tree + command + output cites the run, never duplicates it",
          b2.get("existing") is True and b2.get("id") == b.get("id"),
          str(b2)[:200])

    print("== journal carries refusals")
    jl = (ledger / "events.jsonl").read_text().strip().splitlines()
    refused = [json.loads(l) for l in jl if json.loads(l)["result"] == "REFUSED"]
    check("REFUSED events journaled", len(refused) >= 6, f"got {len(refused)}")
    events = [json.loads(x) for x in jl]
    check("no OK line describes something that did not happen",
          all(e.get("payload") is not None
              for e in events if e["result"] == "OK"))
    seqs = [json.loads(l)["seq"] for l in jl]
    check("seq contiguous", seqs == list(range(1, len(seqs) + 1)))

    print("== doctor: clean / bypass / rebuild / tamper")
    rc, b = run(["doctor"], env=env)
    check("doctor CLEAN", rc == 0 and b.get("ok") is True)
    with sqlite3.connect(ledger / "mp.db") as db:  # write OUTSIDE the write path
        db.execute("INSERT INTO contracts (id,text) VALUES (99,'bypass')")
    rc, b = run(["doctor"], rc=2, env=env)
    check("doctor detects out-of-path DB write",
          any("divergence" in x for x in b.get("findings", [])))
    rc, b = run(["rebuild"], env=env)
    check("rebuild ok", b.get("ok") is True)
    rc, b = run(["doctor"], env=env)
    check("doctor CLEAN after rebuild", rc == 0)
    f.write_text(f.read_text() + "\nquietly edited after seal\n")
    rc, b = run(["doctor"], rc=2, env=env)
    check("doctor detects post-seal tamper",
          any("MODIFIED after seal" in x for x in b.get("findings", [])))

    print()
    if FAILS:
        print(f"SMOKE: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("SMOKE: all checks passed")

if __name__ == "__main__":
    main()
