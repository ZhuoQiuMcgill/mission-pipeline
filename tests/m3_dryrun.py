#!/usr/bin/env python3
"""M3 gate — the dry run, driven by DOCUMENTS (v1.1.0).

A toy mission from claim to a closed gate using only the calls a v1.1 agent
makes: `mp seal`, `mp run record`, `mp wave open`, `mp supersede`, `mp relay`,
`mp calib triggers|check|bundle`. Nothing is declared twice: every edge, every
evidence row, every flag, every verdict, every round and every disposition is
DERIVED from the markdown the seat had to write anyway.

  L1  a Charter prohibition ratifies itself into a standing contract at seal;
      a Crititor anchors on it as F-type evidence (`contract:<id>`).
  L2  the Charter re-issues to v2; the spec still anchored at `charter:v1` is
      not a lint finding — it is a `mp worklist` item, and blocks nothing.
  L3  `mp calib triggers` computes the four task-cell triggers from the ledger:
      post-compaction fires only for a spec inside the window that touches a
      contract; recovery and post-amendment fire for the tasks that earned them.
  L5  the aggregate cell: SUSPICION, SUSPICION -> the next `mp wave open` is
      REFUSED (the ratchet the PM cannot absorb) until the principal supersedes
      the verdict; DRIFT halts the fan-out the same way.
  End the Integration Note's flag ledger disposes every flag and closes the
      wave; `mp acts` lists what was done in the principal's name; a closing run
      binds the gate to the tree it judged; doctor / rebuild / doctor.

Run: python3 tests/m3_dryrun.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MP = str(REPO / "skills" / "mission-pipeline" / "scripts" / "mp")
sys.dont_write_bytecode = True  # no __pycache__ in the working tree
sys.path.insert(0, str(REPO / "tests" / "fixtures"))
from docs import write as fixture  # noqa: E402

M = "Week03-DryRun"
FAILS = []
ENV = {}
TMP = None

# the verbs v1.0 made agents type by hand; v1.1 derives every one of them
DECLARATION_ACTIONS = {
    "artifact.new", "artifact.seal", "edge.add", "evidence.add", "flag.add",
    "flag.dispose", "verdict.record", "round.open", "round.close",
    "charter.seal", "charter.amend", "contract.add", "gate.record",
    "fingerprint.take",
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

def led(fname):
    return f".claude/mission-pipeline/ledger/{M}/{fname}"

def doc(fname, kind, **kw):
    kw.setdefault("mission", M)
    fixture(TMP, led(fname), kind, **kw)
    return led(fname)

def seal(fname, kind, rc=0, **kw):
    return run(["seal", doc(fname, kind, **kw)], rc=rc)

def journal():
    return [json.loads(x) for x in
            (TMP / ".claude" / "mission-pipeline" / "ledger"
             / "events.jsonl").read_text(encoding="utf-8").splitlines()
            if x.strip()]

def roles_in(bundle):
    return sorted({f["role"] for f in bundle.get("files", [])})

# ---------------------------------------------------------------- the dry run

def main():
    global TMP, ENV
    TMP = Path(tempfile.mkdtemp(prefix="mp-m3-"))
    ENV = dict(os.environ, MP_ROOT=str(TMP), MP_ACTOR="pm")
    g = lambda *a: subprocess.run(["git", "-C", str(TMP)] + list(a),
                                  capture_output=True, text=True)
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (TMP / "src.txt").write_text("the toy project\n")
    (TMP / "tests.txt").write_text("the toy suite\n")
    g("add", "-A")
    g("commit", "-qm", "init")
    run(["init"])

    print("== kickoff: claim, Charter, ratified prohibitions")
    run(["mission", "claim", M, "--cap", "3", "--branch", "mission/week03"])
    rc, b = seal("Charter_v01.md", "charter", version=1, derives="none",
                 goal="correctness over speed; never widen a tolerance to make"
                      " a test pass",
                 prohibitions="- never widen a test's tolerance to make it pass"
                              "\n- never ship a migration without a rollback",
                 amendments="| v1 | 2026-08-31 | (initial seal) | — |")
    charter1 = b["artifact"]["id"]
    contracts = [c["id"] for c in b["contracts"]]
    check("L1 — the Charter's prohibitions ratify themselves at seal",
          len(contracts) == 2
          and b["contracts"][0]["origin"].startswith("charter:v1"),
          str(b.get("contracts"))[:250])
    check("the Charter is the mission's frozen basis at v1",
          b["charter"]["version"] == 1)

    print("== wave 1: a spec that touches a contract")
    rc, b = run(["wave", "open", "W1", "--mission", M, "--tasks", "T1"])
    check("wave W1 opens", b.get("ok") is True)
    rc, b = seal("TaskSpec_T1_v01.md", "taskspec", key="T1", version=1,
                 wave="W1", recovers="", touches="yes",
                 derives=f"artifact:{charter1}",
                 objective="the loader reads the env exactly once",
                 ac1="one read per process",
                 out_of_scope="- the retry path\n- the CLI flags")
    spec1 = b["artifact"]["id"]
    check("the spec's wave, touches-contract and lineage are all derived",
          b["artifact"]["wave"] == "W1"
          and b["artifact"]["touches_contract"] == "yes"
          and [e["to"] for e in b["edges"]] == [charter1], str(b)[:300])

    print("== round 1: a run, a report, a critique")
    (TMP / "suite.log").write_text("2 suites green\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", "suite.log", "--tree", "."])
    run1 = b["id"]
    check("the run binds to the tree it judged, not to the mission tip",
          b["tree_path"] == "." and b["tree_hash"], str(b)[:200])
    rc, b = seal("DevReport_T1_r1_v01.md", "devreport", key="T1", round=1,
                 version=1, derives=f"artifact:{spec1}",
                 summary="one read, memoized",
                 runs=f"| run:{run1} | python3 -m pytest -q | 2 suites green |",
                 noticed="- the config loader still reads the file twice on a"
                         " cold cache",
                 relay="\n## Engine relay\n\n- inefficiency: the report template"
                       " asks for the run twice\n")
    dev1 = b["artifact"]["id"]
    flag_dev = b["flags"][0]["id"]
    check("the DevReport's flag and round come from the document",
          b["flags"][0]["kind"] == "noticed-not-fixed"
          and [r["n"] for r in b["rounds"]] == [1], str(b)[:300])
    check("its Engine relay bullet becomes a relay row",
          [r["kind"] for r in b["relay"]] == ["inefficiency"], str(b["relay"]))

    print("== the seal refuses what lint used to report")
    rc, b = seal("Critique_T1_r1_v01.md", "critique", rc=3, key="T1", round=1,
                 version=1, derives=f"artifact:{dev1}", verdict="PASS",
                 criteria=f"| 1 | one read per process | met |"
                          f" artifact:{dev1}:runs | D |",
                 risk="- None", relay="")
    check("a PASS resting only on a derived document is REFUSED at seal",
          "[evidence-anchoring]" in b.get("reason", "")
          and "echoes are not evidence" in b.get("reason", ""),
          b.get("reason", "")[:250])
    rc, b = seal("DevReport_T1_r4_v01.md", "devreport", rc=3, key="T1", round=4,
                 version=1, derives=f"artifact:{spec1}", summary="a 4th round",
                 runs="| None | — | — |", noticed="- None", relay="")
    check("round 4 under a cap of 3 is REFUSED — the cap fires from the header",
          "[round-cap]" in b.get("reason", ""), b.get("reason", "")[:250])

    rc, b = seal("Critique_T1_r1_v01.md", "critique", key="T1", round=1,
                 version=1, derives=f"artifact:{spec1}, artifact:{dev1}",
                 verdict="PASS",
                 criteria=(f"| 1 | one read per process | met | run:{run1} | R |\n"
                           f"| 2 | the tolerance is untouched | met |"
                           f" contract:{contracts[0]} | F |\n"
                           f"| 3 | scope respected | met |"
                           f" charter:v1:prohibitions | F |"),
                 risk="- the deployment story is unowned by any task in this"
                      " wave",
                 relay="\n## Engine relay\n\n- defect: `mp calib bundle` should"
                       " take a wave label\n")
    crit1 = b["artifact"]["id"]
    flag_crit = b["flags"][0]["id"]
    check("L1 — the Crititor anchors on the ratified contract as F evidence",
          any(e["type"] == "F" and e["anchor"] == f"contract:{contracts[0]}"
              for e in b["evidence"]), str(b["evidence"])[:300])
    check("the PASS, the out-of-frame flag and the relay item all derive",
          b["verdicts"][0]["kind"] == "PASS"
          and b["flags"][0]["kind"] == "out-of-frame"
          and len(b["relay"]) == 1, str(b)[:300])
    rc, b = seal("GroupReport_T1_v01.md", "groupreport", key="T1", version=1,
                 derives=f"artifact:{dev1}, artifact:{crit1}",
                 outcome="ACCEPTED", reasoning="one round, anchored")
    check("the Stabilizer's outcome is a verdict row",
          b["verdicts"][0]["kind"] == "ACCEPTED"
          and b["verdicts"][0]["by_role"] == "stabilizer", str(b)[:200])

    print("== the Integration Note disposes the flags and closes the wave")
    rc, b = run(["status"])
    check("both flags are open, and neither was ever typed by hand",
          sorted(f["id"] for f in b["undisposed_flags"])
          == sorted([flag_dev, flag_crit]), str(b.get("undisposed_flags"))[:300])
    rc, b = seal("IntegrationNote_W1_v01.md", "integrationnote", version=1,
                 wave="W1", derives=f"artifact:{crit1}",
                 regrounding="wave 1 delivers the loader the Charter asked for",
                 flags=(f"| {flag_dev} | the config loader still reads the file"
                        f" twice on a cold cache | artifact:{dev1} | routed to"
                        f" T2's spec — the cold-cache path is rewritten there |\n"
                        f"| {flag_crit} | the deployment story is unowned by any"
                        f" task in this wave | artifact:{crit1} | accepted risk"
                        f" — deployment lands in wave W2 |"),
                 compaction="yes", relay="")
    note1 = b["artifact"]["id"]
    check("every flag is disposed and the wave carries its compaction line",
          sorted(d["id"] for d in b["dispositions"])
          == sorted([flag_dev, flag_crit])
          and b["wave_close"]["compaction"] == "yes", str(b)[:300])
    rc, b = run(["status"])
    check("no flag is left open", b["undisposed_flags"] == [])

    print("== L5: the aggregate cell, and the ratchet the PM cannot absorb")
    rc, b = seal("CalibrationVerdict_W1_v01.md", "calibverdict", key="W1",
                 version=1, derives=f"artifact:{charter1}",
                 verdict="SUSPICION", convened="full",
                 accusations="- the authorization chain for the loader's"
                             " memoization is incomplete")
    agg1 = b["verdicts"][0]["id"]
    check("the aggregate verdict is keyed by the wave and ruled by the arbiter",
          b["verdicts"][0]["kind"] == "SUSPICION"
          and b["verdicts"][0]["by_role"] == "arbiter", str(b)[:200])
    rc, b = run(["wave", "open", "W2", "--mission", M, "--tasks", "T2,T3"])
    check("one SUSPICION is a disposition, not a halt", b.get("ok") is True)

    print("== wave 2: the post-compaction window")
    rc, b = seal("TaskSpec_T2_v01.md", "taskspec", key="T2", version=1,
                 wave="W2", recovers="", touches="yes",
                 derives=f"artifact:{note1}",
                 objective="rewrite the cold-cache path",
                 ac1="one file read per process, cold or warm",
                 out_of_scope="- the retry path")
    spec2 = b["artifact"]["id"]
    rc, b = seal("TaskSpec_T3_v01.md", "taskspec", key="T3", version=1,
                 wave="W2", recovers="", touches="no",
                 derives=f"artifact:{note1}",
                 objective="write the deployment note",
                 ac1="the note names every environment",
                 out_of_scope="- the loader itself")
    spec3 = b["artifact"]["id"]
    rc, b = run(["calib", "triggers", "--mission", M])
    fired = {t["task"]: t["triggers"] for t in b["tasks"]}
    check("L3 — post-compaction fires for the spec that touches a contract",
          fired.get("T2") == ["post-compaction"], str(fired))
    check("and NOT for the text-only spec in the same window",
          fired.get("T3") == [], str(fired))
    check("and NOT for the spec written before the compaction",
          fired.get("T1") == [], str(fired))

    print("== T2 runs the loop to the cap; the PASS at the cap triggers a cell")
    prev = spec2
    for n, verdict in ((1, "CHANGES-REQUESTED"), (2, "CHANGES-REQUESTED"),
                       (3, "PASS")):
        rc, b = seal(f"DevReport_T2_r{n}_v01.md", "devreport", key="T2",
                     round=n, version=1, derives=f"artifact:{spec2}",
                     summary=f"attempt {n}",
                     runs=f"| run:{run1} | python3 -m pytest -q |"
                          f" 2 suites green |",
                     noticed="- None", relay="")
        prev = b["artifact"]["id"]
        rc, b = seal(f"Critique_T2_r{n}_v01.md", "critique", key="T2", round=n,
                     version=1, derives=f"artifact:{prev}", verdict=verdict,
                     criteria=(f"| 1 | one file read per process | "
                               + ("met" if verdict == "PASS" else "missed")
                               + f" | run:{run1} | R |"),
                     risk="- None", relay="")
    rc, b = run(["calib", "triggers", "--mission", M, "--task", "T2"])
    check("L3 — a PASS arriving at the cap triggers a cell too",
          sorted(b["tasks"][0]["triggers"]) == ["cap-pass", "post-compaction"],
          str(b["tasks"])[:300])
    rc, b = run(["metrics", "--match", "Week03*"])
    check("metrics reads the derived rounds table: T1 at 1, T2 at the cap",
          b["missions"][M] == {"tasks": 3, "r1": 1, "r2": 0, "r3": 1,
                               "r_other": 1, "escalated": 0},
          str(b.get("missions"))[:300])

    print("== the ratchet: a second SUSPICION halts the next wave")
    rc, b = seal("CalibrationVerdict_W2_v01.md", "calibverdict", key="W2",
                 version=1, derives=f"artifact:{charter1}",
                 verdict="SUSPICION", convened="full",
                 accusations="- the same chain, still incomplete")
    agg2 = b["verdicts"][0]["id"]
    rc, b = run(["wave", "open", "W3", "--mission", M, "--tasks", "T4"], rc=3)
    check("`mp wave open` is REFUSED while the ratchet stands",
          "[suspicion-ratchet]" in b.get("reason", "")
          and "cannot absorb" in b.get("reason", ""), b.get("reason", "")[:300])
    check("the refusal tells the PM exactly what the principal must do",
          f"mp supersede verdict:{agg2}" in b.get("reason", ""),
          b.get("reason", "")[:300])
    rc, b = run(["calib", "check", "--mission", M], rc=2)
    check("calib check reports the same ratchet",
          [f["rule"] for f in b["findings"]] == ["suspicion-ratchet"],
          str(b.get("findings"))[:300])
    rc, b = run(["supersede", f"verdict:{agg2}", "--by", "principal",
                 "--reason", "I read the chain myself; carry on"])
    check("only the principal clears it", b.get("ok") is True)
    rc, b = run(["wave", "open", "W3", "--mission", M, "--tasks", "T4,T5"])
    check("the wave opens once the principal has spoken", b.get("ok") is True)

    print("== DRIFT halts the fan-out the same way")
    rc, b = seal("CalibrationVerdict_W3_v01.md", "calibverdict", key="W3",
                 version=1, derives=f"artifact:{charter1}", verdict="DRIFT",
                 convened="full",
                 accusations="- the delivery set contradicts the Charter's"
                             " first prohibition")
    agg3 = b["verdicts"][0]["id"]
    rc, b = run(["calib", "check", "--mission", M], rc=2)
    check("calib check reports the DRIFT halt",
          [f["rule"] for f in b["findings"]] == ["drift-halt"],
          str(b.get("findings"))[:300])
    rc, b = run(["wave", "open", "W4", "--mission", M, "--tasks", "T6"], rc=3)
    check("`mp wave open` is REFUSED under a standing DRIFT",
          "[drift-halt]" in b.get("reason", ""), b.get("reason", "")[:300])
    run(["supersede", f"verdict:{agg3}", "--by", "principal", "--reason",
         "the prohibition means what T4 assumed; proceed"])
    rc, b = run(["wave", "open", "W4", "--mission", M, "--tasks", "T6"])
    check("and opens once it is superseded", b.get("ok") is True)
    rc, b = run(["calib", "check", "--mission", M])
    check("calib check is clean over LIVE verdicts only",
          rc == 0 and [a["kind"] for a in b["aggregate"]] == ["SUSPICION"],
          str(b.get("aggregate"))[:300])

    print("== the Charter re-issues; the stale anchor goes to the worklist")
    rc, b = seal("Charter_v02.md", "charter", version=2,
                 derives=f"artifact:{charter1}",
                 goal="correctness over speed; never widen a tolerance to make"
                      " a test pass",
                 prohibitions="- never widen a test's tolerance to make it pass"
                              "\n- never ship a migration without a rollback",
                 amendments="| v1 | 2026-08-31 | (initial seal) | — |\n"
                            "| v2 | 2026-08-31 | the retry path is in scope"
                            " after all | read-back 2026-08-31 #2 |")
    charter2 = b["artifact"]["id"]
    check("the amendment carries the principal's verbatim words",
          b["charter"]["quote"] == "the retry path is in scope after all"
          and b["charter"]["readback"] == "read-back 2026-08-31 #2",
          str(b.get("charter"))[:300])
    check("v2 supersedes v1's artifact automatically",
          [s["id"] for s in b["supersede"]] == [charter1], str(b["supersede"]))
    rc, b = run(["lint", "--mission", M])
    check("the stale charter:v1 anchor is not a lint finding",
          rc == 0 and b.get("ok") is True, str(b.get("findings"))[:400])
    rc, b = run(["worklist", "--mission", M])
    kinds = {i["kind"] for i in b["items"]}
    check("it is a worklist item, owned by the PM, blocking nothing",
          rc == 0 and "stale-charter-anchor" in kinds and b["owner"] == "pm",
          str(b.get("items"))[:400])
    check("so is the lineage that now points at a superseded Charter",
          "stale-lineage" in kinds, str(sorted(kinds)))

    print("== the triggers the amendment and a recovery task arm")
    rc, b = run(["wave", "open", "W5", "--mission", M, "--tasks", "T7"])
    rc, b = seal("TaskSpec_T7_v01.md", "taskspec", key="T7", version=1,
                 wave="W5", recovers="recovers: T1", touches="no",
                 derives=f"artifact:{charter2}",
                 objective="repair T1's cold-cache escalation",
                 ac1="the cold path reads once",
                 out_of_scope="- the deployment note")
    check("a spec may declare the task it recovers",
          b["artifact"]["recovers"] == "T1", str(b["artifact"])[:300])
    rc, b = run(["calib", "triggers", "--mission", M, "--task", "T7"])
    check("L3 — recovery and post-amendment both fire for it",
          sorted(b["tasks"][0]["triggers"])
          == ["post-amendment", "recovery-task"], str(b["tasks"])[:400])

    print("== calib bundle: the starved seat and the fed seat, by wave")
    rc, cal = run(["calib", "bundle", "--mission", M, "--wave", "W1",
                   "--seat", "calibrator"])
    check("the wave label names the tasks — the PM does not curate them",
          [t["task"] for t in cal["tasks"]] == ["T1"], str(cal.get("tasks"))[:200])
    check("the calibrator gets the delivery set only",
          roles_in(cal) == ["DevReport"], str(roles_in(cal)))
    check("no spec, critique or note path reaches the starved seat",
          not any(w in json.dumps(cal["files"])
                  for w in ("TaskSpec", "Critique", "IntegrationNote")),
          json.dumps(cal["files"])[:300])
    check("the calibrator reads the CURRENT Charter",
          cal["charter"]["version"] == 2, str(cal.get("charter")))
    check("no amendment ledger for the starved seat", "amendments" not in cal)
    rc, chal = run(["calib", "bundle", "--mission", M, "--wave", "W2",
                    "--seat", "challenger"])
    check("the challenger gets the web: specs, critiques, notes",
          roles_in(chal) == ["Critique", "DevReport", "IntegrationNote",
                             "TaskSpec"], str(roles_in(chal)))
    check("the challenger gets the amendment history with the verbatim words",
          [a["version"] for a in chal["amendments"]] == [1, 2]
          and "retry path is in scope" in chal["amendments"][1]["verbatim_quote"],
          str(chal.get("amendments"))[:300])

    print("== the relay: the engine's own defect queue")
    run(["relay", "add", "--kind", "defect", "--text",
         "`mp status` does not show open waves", "--mission", M])
    rc, b = run(["relay", "list"])
    kinds = [r["kind"] for r in b["items"]]
    check("relay rows come from documents and from the PM alike",
          sorted(kinds) == ["defect", "defect", "inefficiency"], str(kinds))
    check("the ones from documents name the artifact that provoked them",
          all(r["source"] for r in b["items"] if r["kind"] != "defect"
              or "wave label" in r["text"]), str(b["items"])[:300])
    rc, b = run(["relay", "export"])
    check("export is PR-body-ready markdown grouped by kind",
          "# Engine relay" in b["markdown"] and "## Defects" in b["markdown"]
          and "## Inefficiencies" in b["markdown"], b.get("markdown", "")[:200])

    print("== acts in your name")
    rc, b = run(["acts", "--mission", M])
    kinds = [a["kind"] for a in b["acts"]]
    check("the amendment is listed with the principal's own sentence",
          any(a["kind"] == "charter-amendment"
              and a["words"] == "the retry path is in scope after all"
              for a in b["acts"]), str(b["acts"])[:400])
    check("so are the ratifications, the dispositions and the supersessions",
          {"contract-ratified", "flag-disposition",
           "principal-supersession"} <= set(kinds), str(sorted(set(kinds))))
    check("each supersession carries the principal's reason",
          all(a["words"] for a in b["acts"]
              if a["kind"] == "principal-supersession"), str(b["acts"])[:300])

    print("== close: a closing run, then the hardened gate")
    rc, b = run(["gate", "close", "--mission", M], rc=2)
    check("the gate refuses with no closing run recorded",
          any("closing-gate-logged" in f for f in b["failures"]),
          str(b.get("failures"))[:300])
    (TMP / "closing-gate.log").write_text("all 2 suites green\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q --full",
                 "--log", "closing-gate.log", "--scope", "closing",
                 "--mission", M])
    check("the closing run is recorded against the judged tree",
          b.get("existing") is False and b["scope"] == "closing", str(b)[:200])
    rc, b = run(["gate", "close", "--mission", M])
    check("gate close PASSES and closes the mission",
          rc == 0 and b.get("result") == "PASSED" and b.get("closed_at"),
          str(b.get("failures"))[:400])
    check("every closing check is recorded, one by one",
          [c["check"] for c in b["checks"]]
          == ["charter-sealed", "flags-disposed", "closing-gate-logged",
              "source-unchanged", "lint-clean"]
          and all(c["ok"] for c in b["checks"]), str(b.get("checks"))[:400])

    print("== the artifact WAS the event")
    jl = journal()
    declared = [e for e in jl if e["action"] in DECLARATION_ACTIONS]
    check("not one declaration verb was used in the whole mission",
          declared == [], str([e["action"] for e in declared])[:300])
    seals = [e for e in jl if e["action"] == "artifact.sealed"
             and e["result"] == "OK"]
    derived = sum(len(e["payload"][k]) for e in seals
                  for k in ("edges", "evidence", "flags", "verdicts",
                            "dispositions", "contracts", "relay", "rounds"))
    check("every derived row rode a seal event",
          len(seals) >= 18 and derived >= 40,
          f"{len(seals)} seals, {derived} derived rows")
    print(f"       ({len(jl)} journal events, {len(seals)} sealed artifacts,"
          f" {derived} rows derived from them —"
          f" {len(jl) / len(seals):.2f} events per artifact)")

    print("== the substrate survives its own dry run")
    rc, b = run(["doctor"])
    check("doctor CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])
    rc, b = run(["rebuild"])
    n_events = b.get("events")
    check("rebuild replays every event, skipping none",
          b.get("ok") is True and not b.get("replay_skips"), str(b)[:300])
    rc, b = run(["doctor"])
    check("doctor CLEAN after rebuild", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])
    rc, b = run(["lint", "--mission", M])
    check("lint CLEAN on the rebuilt DB", rc == 0 and b.get("ok") is True)
    rc, b = run(["calib", "check", "--mission", M])
    check("calib check CLEAN on the rebuilt DB", rc == 0 and b.get("ok") is True)
    print(f"       ({n_events} journal events replayed)")

    print()
    if FAILS:
        print(f"M3 DRY RUN: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("M3 DRY RUN PASSED — a whole mission driven by documents: L1"
          " prohibition catch, L2 re-issue + worklist, L3 computed triggers,"
          " L5 ratchet + DRIFT halt, closed through the gate")

if __name__ == "__main__":
    main()
