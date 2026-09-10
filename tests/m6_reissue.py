#!/usr/bin/env python3
"""M6 gate — RE-ISSUE RECONCILIATION (new at v1.2.0).

    a 17-item residue list, sealed across three versions of the same document,
    leaves exactly 17 live flags.

In the field it left 52. Sealing a correction version superseded the ARTIFACT
and nothing it had derived, so every version re-derived the whole list beside
its own twins: one task's three DevReports produced 52 flags for ~17 items, and
its mission carried 77 undisposed flags toward a close that counts them
(relay 20/21/24). The other half of the same lesson: a Constructor who wrote
"round 1's flags still stand and are not restated here" — the correct thing to
write — had that sentence turned into a NEW flag about flags (relay 9).

  v01  17 bullets                        -> 17 new flags
       one of them is disposed by an Integration Note
  v02  the same 17, two of them reworded -> 15 carried (ids and dispositions
                                            kept), 2 retired, 2 new = 17 live
  v03  16 of them + `- carried: flag:<id>` for the seventeenth
                                         -> 17 carried, 0 new, 0 retired

and, on the other records: re-issuing a Critique supersedes the evidence rows,
the verdict, the edges and the relay items its previous version derived.

Run: python3 tests/m6_reissue.py
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

M = "Week07-Reissue"
FAILS = []
ENV = {}
TMP = None

# the residue list a real DevReport carries: 17 items, verbatim, none of them
# about the ledger (invariant: flags are about the product)
RESIDUE = [
    "the config loader still reads the file twice on a cold cache",
    "the retry path is untested above three attempts",
    "the migration has no rollback for the partial-write case",
    "the CLI swallows a KeyboardInterrupt during teardown",
    "timestamps are recorded at second resolution, not millisecond",
    "the health endpoint reports ready before the pool is warm",
    "two callers construct the client without the shared timeout",
    "the fixture directory is copied, not linked, on every run",
    "error messages name the internal field, not the public one",
    "the batch size is hard-coded at 500 in two places",
    "the parser accepts a trailing comma but the writer never emits one",
    "the cache key ignores locale",
    "the worker pool has no back-pressure above the queue high-water mark",
    "a failed upload leaves the temp file behind",
    "the audit log records the actor but not the reason",
    "the schema allows a NULL where the domain does not",
    "the docs still describe the pre-rename flag",
]
REWORD = {
    1: "the retry path is untested above three attempts (and above five)",
    9: "error messages name the internal field, never the public one",
}


def check(name, cond, detail=""):
    print(("  ok  " if cond else "  FAIL") + f" {name}"
          + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def run(args, rc=0):
    r = subprocess.run([sys.executable, MP, "--json"] + args,
                       capture_output=True, text=True, encoding="utf-8", env=ENV)
    body = {}
    if r.stdout.strip():
        try:
            body = json.loads(r.stdout.strip().splitlines()[-1])
        except json.JSONDecodeError:
            pass
    if r.returncode != rc:
        check(f"`mp {' '.join(args)}` rc={rc}", False,
              f"got rc={r.returncode} out={r.stdout.strip()[:400]}"
              f" err={r.stderr.strip()[:300]}")
    return r.returncode, body


def led(fname):
    return f".claude/mission-pipeline/ledger/{M}/{fname}"


def doc(fname, kind, **kw):
    kw.setdefault("mission", M)
    fixture(TMP, led(fname), kind, **kw)
    return led(fname)


def seal(fname, kind, rc=0, **kw):
    return run(["seal", doc(fname, kind, **kw)], rc=rc)


def db_rows(sql, params=()):
    con = sqlite3.connect(str(TMP / ".claude" / "mission-pipeline" / "ledger"
                              / "mp.db"))
    rows = con.execute(sql, params).fetchall()
    con.close()
    return rows


def live_flags():
    return db_rows("SELECT id, text_verbatim, disposition, source_artifact"
                   " FROM flags WHERE superseded_by IS NULL ORDER BY id")


# ---------------------------------------------------------------- the gate

def main():
    global TMP, ENV
    TMP = Path(tempfile.mkdtemp(prefix="mp-m6-"))
    ENV = dict(os.environ, MP_ROOT=str(TMP), MP_ACTOR="constructor:T1")
    g = lambda *a: subprocess.run(["git", "-C", str(TMP)] + list(a),
                                  capture_output=True, text=True, encoding="utf-8")
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (TMP / "src.txt").write_text("the toy project\n")
    g("add", "-A")
    g("commit", "-qm", "init")
    run(["init"])

    print("== a mission, a wave, a spec, a run")
    rc, b = seal("Charter_v01.md", "charter", version=1, derives="none",
                 goal="a service that never double-writes",
                 prohibitions="- never widen a tolerance to make a test pass",
                 amendments="| v1 | 2026-09-05 | (initial seal) | — |")
    charter = b["artifact"]["id"]
    run(["wave", "open", "W1", "--mission", M, "--tasks", "T1"])
    rc, b = seal("TaskSpec_T1_v01.md", "taskspec", key="T1", version=1,
                 wave="W1", recovers="", touches="no",
                 derives=f"artifact:{charter}",
                 objective="write once, exactly once",
                 ac1="the suite is green", out_of_scope="- the retry path")
    spec = b["artifact"]["id"]
    (TMP / "suite.log").write_text("2 suites green\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q", "--log",
                 "suite.log", "--result", "pass", "--mission", M])
    rid = b["id"]

    def devreport(version, items, rc=0):
        return seal(f"DevReport_T1_r1_v{version:02d}.md", "devreport", rc=rc,
                    key="T1", round=1, version=version,
                    derives=f"artifact:{spec}",
                    summary=f"round 1, correction version {version}",
                    runs=f"| run:{rid} | python3 -m pytest -q | 2 green |",
                    noticed="\n".join(f"- {x}" for x in items),
                    relay="\n## Engine relay\n\n- inefficiency: the residue list"
                          " has to be restated in full on every correction\n")

    print("== v01: a 17-item residue list")
    rc, b = devreport(1, RESIDUE)
    dev1 = b["artifact"]["id"]
    relay1 = [r["id"] for r in b["relay"]]
    check("seventeen bullets became seventeen flags",
          len(b["flags"]) == 17 and len(live_flags()) == 17,
          f"{len(b['flags'])} derived, {len(live_flags())} live")
    ids1 = {f["text"]: f["id"] for f in b["flags"]}

    print("== one of them is disposed by the wave's Integration Note")
    disposed_text = RESIDUE[0]
    disposed_id = ids1[disposed_text]
    rc, b = seal("IntegrationNote_W1_v01.md", "integrationnote", version=1,
                 wave="W1", derives=f"artifact:{dev1}",
                 regrounding="wave 1 delivers the write path",
                 flags=(f"| {disposed_id} | {disposed_text} |"
                        f" artifact:{dev1} | routed to T2's spec — the"
                        f" cold-cache path is rewritten there |"),
                 compaction="no", relay="")
    check("the disposition lands on the flag",
          [r[2] for r in live_flags() if r[0] == disposed_id]
          == ["routed to T2's spec — the cold-cache path is rewritten there"],
          str(live_flags()[:1]))

    print("== v02: the same list, two items reworded")
    v2_items = [REWORD.get(i, x) for i, x in enumerate(RESIDUE)]
    rc, b = devreport(2, v2_items)
    dev2 = b["artifact"]["id"]
    carried = {c["id"] for c in b["flag_carries"]}
    new = {f["id"]: f["text"] for f in b["flags"]}
    retired = {s["id"] for s in b["supersede"] if s["kind"] == "flag"}
    check("fifteen flags are CARRIED — same ids, no duplicates",
          len(carried) == 15
          and carried == {i for t, i in ids1.items()
                          if t not in (RESIDUE[1], RESIDUE[9])}, str(carried))
    check("the two reworded ones are retired and replaced, not doubled",
          len(new) == 2 and set(new.values()) == set(REWORD.values())
          and retired == {ids1[RESIDUE[1]], ids1[RESIDUE[9]]},
          f"new={new} retired={retired}")
    live = live_flags()
    check("the ledger holds exactly 17 live flags, not 34",
          len(live) == 17, f"{len(live)} live")
    check("the carried flag kept its id AND its disposition",
          [(r[0], r[2]) for r in live if r[0] == disposed_id]
          == [(disposed_id, "routed to T2's spec — the cold-cache path is"
                            " rewritten there")], str(live)[:300])
    check("and every carried flag now points at the version that restated it",
          all(r[3] == dev2 for r in live), str(live)[:300])
    check("v01's relay item retired with the version that raised it",
          db_rows("SELECT superseded_by FROM relay WHERE id=?", (relay1[0],))
          == [(f"artifact:{dev2}",)],
          str(db_rows("SELECT id, superseded_by FROM relay")))
    rc, b = run(["relay", "list"])
    check("so `mp relay list` shows one item per live document, not one per"
          " version",
          len([r for r in b["items"] if "restated in full" in r["text"]]) == 1,
          str(b["items"])[:400])

    print("== v03: sixteen restated, the seventeenth CARRIED by id")
    live_by_text = {r[1]: r[0] for r in live_flags()}
    keep = v2_items[:16]
    last = v2_items[16]
    v3_items = keep + [f"carried: flag:{live_by_text[last]}"]
    rc, b = devreport(3, v3_items)
    dev3 = b["artifact"]["id"]
    check("nothing new is derived — seventeen carries, zero flags",
          len(b["flags"]) == 0 and len(b["flag_carries"]) == 17
          and not [s for s in b["supersede"] if s["kind"] == "flag"],
          f"{len(b['flags'])} new, {len(b['flag_carries'])} carried")
    final = live_flags()
    check("THE MEASUREMENT: 17 items, three versions, 17 live flags",
          len(final) == 17, f"{len(final)} live flags")
    check("a `carried:` bullet is never itself a flag",
          not any("carried:" in r[1] for r in final),
          str([r[1] for r in final if "carried" in r[1]]))
    check("the disposed one still carries its disposition, three versions on",
          [(r[0], r[2]) for r in final if r[0] == disposed_id]
          == [(disposed_id, "routed to T2's spec — the cold-cache path is"
                            " rewritten there")], str(final)[:300])
    check("every live flag's text is one of the seventeen the document lists",
          {r[1] for r in final} == set(v2_items),
          str(sorted({r[1] for r in final} ^ set(v2_items)))[:300])
    rc, b = run(["status"])
    check("`mp status` counts sixteen open flags and no ghosts",
          len(b["undisposed_flags"]) == 16, str(len(b["undisposed_flags"])))
    check("all three DevReport versions are on the record, v01 and v02 retired",
          db_rows("SELECT id, superseded_by FROM artifacts WHERE category="
                  "'DevReport' ORDER BY id")
          == [(dev1, f"artifact:{dev2}"), (dev2, f"artifact:{dev3}"),
              (dev3, None)],
          str(db_rows("SELECT id, superseded_by FROM artifacts WHERE"
                      " category='DevReport' ORDER BY id")))

    print("== a `carried:` pointing at nothing is REFUSED")
    rc, b = devreport(4, keep + ["carried: flag:99999"], rc=3)
    check("an unknown flag id is REFUSED, and says how to carry one",
          "[carried-flag]" in b.get("reason", "")
          and "does not exist" in b.get("reason", ""), b.get("reason", "")[:400])
    rc, b = devreport(4, keep + ["carried: a risk nobody ever raised"], rc=3)
    check("and so is text that matches no live flag",
          "[carried-flag]" in b.get("reason", "")
          and "matches no live flag" in b.get("reason", ""),
          b.get("reason", "")[:400])
    rc, b = devreport(4, keep + [f"carried: flag:{live_by_text[last]}"])
    dev4 = b["artifact"]["id"]
    check("the fixed version seals, and the count holds at 17",
          rc == 0 and len(live_flags()) == 17, f"{len(live_flags())} live")

    print("== the cascade on the other records: a re-issued Critique")
    rc, b = seal("Critique_T1_r1_v01.md", "critique", key="T1", round=1,
                 version=1, derives=f"artifact:{dev4}, artifact:{spec}",
                 verdict="CHANGES-REQUESTED",
                 criteria=(f"| 1 | the write path writes once | met |"
                           f" run:{rid} | R |\n"
                           f"| 2 | the residue is listed | met |"
                           f" charter:v1 | F |"),
                 risk="- the deployment story is unowned",
                 relay="\n## Engine relay\n\n- defect: the criteria table has"
                       " no column for the round it was judged in\n")
    crit1 = b["artifact"]["id"]
    ev1 = sorted(e["id"] for e in b["evidence"])
    verd1 = b["verdicts"][0]["id"]
    crit_relay1 = b["relay"][0]["id"]
    risk_flag = b["flags"][0]["id"]
    check("v01 derives two evidence rows, a verdict, two edges, a relay item"
          " and one out-of-frame flag",
          len(ev1) == 2 and len(b["edges"]) == 2 and len(b["relay"]) == 1
          and len(b["flags"]) == 1, str(b)[:300])
    rc, b = seal("Critique_T1_r1_v02.md", "critique", key="T1", round=1,
                 version=2, derives=f"artifact:{dev4}, artifact:{spec}",
                 verdict="PASS",
                 criteria=f"| 1 | the write path writes once | met |"
                          f" run:{rid} | R |",
                 risk="- the deployment story is unowned",
                 relay="\n## Engine relay\n\n- defect: the criteria table has"
                       " no column for the round it was judged in\n")
    crit2 = b["artifact"]["id"]
    kinds = sorted({s["kind"] for s in b["supersede"]})
    check("re-issuing it supersedes the artifact, its evidence, its verdict"
          " and its relay item — the cascade the field did by hand",
          kinds == ["artifact", "evidence", "relay", "verdict"], str(kinds))
    check("every v01 evidence row is retired",
          db_rows("SELECT DISTINCT superseded_by FROM evidence WHERE"
                  " artifact=?", (crit1,)) == [(f"artifact:{crit2}",)],
          str(db_rows("SELECT id, superseded_by FROM evidence")))
    check("so is the verdict it carried",
          db_rows("SELECT superseded_by FROM verdicts WHERE id=?", (verd1,))
          == [(f"artifact:{crit2}",)], str(verd1))
    check("so is its relay item",
          db_rows("SELECT superseded_by FROM relay WHERE id=?",
                  (crit_relay1,)) == [(f"artifact:{crit2}",)], str(crit_relay1))
    check("and so are its edges — a superseded document derives from nothing",
          db_rows("SELECT DISTINCT superseded_by FROM edges WHERE"
                  " from_artifact=?", (crit1,)) == [(f"artifact:{crit2}",)],
          str(db_rows("SELECT from_artifact, to_artifact, superseded_by"
                      " FROM edges")))
    check("but the out-of-frame flag it raised is CARRIED, not doubled",
          [c["id"] for c in b["flag_carries"]] == [risk_flag]
          and len(b["flags"]) == 0, str(b.get("flag_carries")))
    check("the mission still holds exactly 18 live flags — 17 residue, 1 risk",
          len(live_flags()) == 18, f"{len(live_flags())} live")

    print("== and it all replays")
    rc, b = run(["lint", "--mission", M])
    check("lint CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])
    rc, b = run(["rebuild"])
    check("rebuild replays every seal, skipping none",
          b.get("ok") is True and not b.get("replay_skips"), str(b)[:300])
    check("the replayed ledger holds the same 18 live flags, with the same ids"
          " and the same disposition",
          len(live_flags()) == 18
          and [(r[0], r[2]) for r in live_flags() if r[0] == disposed_id]
          == [(disposed_id, "routed to T2's spec — the cold-cache path is"
                            " rewritten there")], str(len(live_flags())))
    rc, b = run(["doctor"])
    check("doctor CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])

    print()
    if FAILS:
        print(f"M6 RE-ISSUE: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("M6 RE-ISSUE GATE PASSED — a 17-item residue list survives three"
          " correction versions as 17 flags with their ids and dispositions"
          " intact, and every other derived record retires with the version"
          " that made it")


if __name__ == "__main__":
    main()
