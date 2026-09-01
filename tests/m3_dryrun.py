#!/usr/bin/env python3
"""M3 gate, mechanical half (DesignDoc_CalibrationAndSubstrate v02, §11):

    a dry-run mission exercises the defense layers — prohibition catch (L1),
    Charter-lint catch (L2), triggered task cell (L3), SUSPICION ratchet and
    DRIFT halt (L5)

at substrate level: one scripted toy mission, built through `mp` alone, from
claim to a closed gate. The judgment halves of those layers live in the roles;
what is testable here is that the ledger carries each layer's fact and that the
engine routes on it.

  L1  a Charter prohibition ratified into a standing contract; the Crititor's
      CHANGES-REQUESTED cites it as F-type evidence (`contract:<id>`).
  L2  the Charter amends to v2; `mp lint` marks the spec still anchored at
      `charter:v1` stale — the propagation check, no judgment required.
  L3  a task-level cell files DRIFT for T3; `mp calib check` reports the open
      cell; the verdict re-enters the build loop as CHANGES-REQUESTED.
  L5  the aggregate cell runs per wave: SUSPICION, SUSPICION (the ratchet the PM
      cannot absorb), DRIFT (fan-out halted), ALIGNED (clean); `mp calib bundle`
      feeds the starved seat and the fed seat by rule, never by PM curation.
  End dispose every flag, retire the stale anchor on a *new* version (sealed
      versions are never edited), record the closing gate, `mp gate close`,
      then doctor / rebuild / doctor.

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
M = "Week03-DryRun"

FAILS = []
ENV = {}
TMP = None

def check(name, cond, detail=""):
    print(("  ok  " if cond else "  FAIL") + f" {name}"
          + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)

def run(args, rc=0, env=None):
    r = subprocess.run([sys.executable, MP, "--json"] + args,
                       capture_output=True, text=True, env=env or ENV)
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

def art(cat, key, ver, rnd=0, derives="none", role="constructor", seal=True,
        body="body"):
    """Write the artifact with its machine-readable header, register it, seal it."""
    p = ledger() / M / f"{cat}_{key}_r{rnd}_v{ver:02d}.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("<!-- mp:header\n"
                 f"mission: {M}\ncategory: {cat}\nkey: {key}\nround: {rnd}\n"
                 f"version: {ver}\nderives-from: {derives}\n-->\n"
                 f"# {cat} — {key} v{ver}\n\n{body}\n", encoding="utf-8")
    rc, b = run(["artifact", "new", "--mission", M, "--category", cat, "--key",
                 key, "--round", str(rnd), "--version", str(ver), "--path",
                 str(p.relative_to(TMP)), "--author-role", role])
    aid = b["payload"]["id"]
    if seal:
        run(["artifact", "seal", str(aid)])
    return aid, p

def evidence(aid, criterion, typ, anchor, fp=None, sha=None, cmd=None):
    args = ["evidence", "add", "--artifact", str(aid), "--criterion", criterion,
            "--type", typ, "--anchor", anchor]
    if fp:
        args += ["--fingerprint", str(fp)]
    if sha:
        args += ["--output-sha", sha]
    if cmd:
        args += ["--cmd", cmd]
    return run(args)

def fingerprint():
    rc, b = run(["fingerprint", "take"])
    return b["payload"]["id"]

def verdict(kind, task="", artifact=None, by="crititor"):
    args = ["verdict", "record", "--mission", M, "--task", task, "--kind", kind,
            "--by", by]
    if artifact:
        args += ["--artifact", str(artifact)]
    return run(args)

def journal():
    return [json.loads(l) for l in
            (ledger() / "events.jsonl").read_text(encoding="utf-8").splitlines()
            if l.strip()]

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

    print("== kickoff: claim, Charter, ratified prohibitions (signing)")
    run(["mission", "claim", M, "--cap", "3", "--branch", "mission/week03"])
    ch1, ch1p = art("Charter", M, 1, role="pm",
                    body="The principal's words: \"correctness over speed;\n"
                         "never widen a tolerance to make a test pass.\"")
    run(["charter", "seal", "--mission", M, "--path", str(ch1p.relative_to(TMP)),
         "--by", "principal"])
    rc, b = run(["contract", "add", "--text",
                 "never widen a test's tolerance to make it pass", "--origin",
                 f"Charter v1 prohibition ({M})", "--verified-by", "crititor",
                 "--ratified", "2026-08-31"])
    cid = b["payload"]["id"]
    check("prohibition ratified into a standing contract at signing",
          b.get("ok") is True and cid)

    print("== L1: the standing contract catches the violation in round 1")
    run(["round", "open", "--mission", M, "--task", "T1", "--n", "1"])
    spec1, _ = art("TaskSpec", "T1", 1, role="architect")
    evidence(spec1, "scope", "F", "charter:v1:correctness-over-speed")
    dev1, _ = art("DevReport", "T1", 1, rnd=1, derives=str(spec1))
    crit1, _ = art("Critique", "T1", 1, rnd=1, derives=f"{spec1}, {dev1}",
                   role="crititor")
    evidence(crit1, "prohibition: tolerance", "F", f"contract:{cid}")
    verdict("CHANGES-REQUESTED", "T1", crit1)
    run(["edge", "add", "--from", str(crit1), "--to", str(spec1),
         "--kind", "cites"])
    run(["round", "close", "--mission", M, "--task", "T1", "--n", "1"])
    jl = journal()
    check("the F anchor cites the standing contract",
          any(e["action"] == "evidence.add" and e["result"] == "OK"
              and e["payload"]["anchor"] == f"contract:{cid}"
              and e["payload"]["type"] == "F" for e in jl))
    check("CHANGES-REQUESTED recorded against the critique",
          any(e["action"] == "verdict.record" and e["result"] == "OK"
              and e["payload"]["kind"] == "CHANGES-REQUESTED"
              and e["payload"]["artifact"] == crit1 for e in jl))

    print("== L2: the Charter amends; the spec's anchor goes stale")
    rc, b = run(["lint", "--mission", M])
    check("lint clean before the amendment", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:300])
    ch2, ch2p = art("Charter", M, 2, role="pm",
                    body="Amendment v2: \"the retry path is in scope after all.\"")
    run(["charter", "amend", "--mission", M, "--path",
         str(ch2p.relative_to(TMP)), "--by", "principal", "--quote",
         "yes — the retry path is in scope after all", "--readback",
         "readback 2026-08-31 #2"])
    rc, b = run(["lint", "--mission", M], rc=2)
    stale = [f for f in b.get("findings", []) if f["rule"] == "stale-charter"]
    check("lint marks the spec still anchored at charter:v1 stale",
          len(stale) == 1 and stale[0]["artifact"] == spec1,
          str(b.get("findings"))[:400])
    check("the finding names the amendment that caused it",
          "charter:v1" in stale[0]["message"] and "v2" in stale[0]["message"],
          stale[0]["message"] if stale else "")

    print("== round 2: the fix lands, anchored on reality and the current Charter")
    run(["round", "open", "--mission", M, "--task", "T1", "--n", "2"])
    dev2, _ = art("DevReport", "T1", 2, rnd=2, derives=str(spec1))
    crit2, _ = art("Critique", "T1", 2, rnd=2, derives=f"{spec1}, {dev2}",
                   role="crititor")
    fp = fingerprint()
    evidence(crit2, "AC1: tolerance untouched", "R", "python3 -m pytest -q",
             fp=fp, sha="ab" * 32, cmd="python3 -m pytest -q")
    evidence(crit2, "AC2: scope", "F", "charter:v2:retry-path")
    verdict("PASS", "T1", crit2)
    run(["edge", "add", "--from", str(crit2), "--to", str(dev2),
         "--kind", "derives-from"])
    run(["round", "close", "--mission", M, "--task", "T1", "--n", "2"])
    gr1, _ = art("GroupReport", "T1", 1, derives=f"{dev2}, {crit2}",
                 role="stabilizer")
    run(["edge", "add", "--from", str(gr1), "--to", str(crit2),
         "--kind", "carries"])
    verdict("ACCEPTED", "T1", by="stabilizer")

    print("== L3: a triggered task cell files DRIFT for T3")
    run(["round", "open", "--mission", M, "--task", "T3", "--n", "1"])
    spec3, _ = art("TaskSpec", "T3", 1, role="architect")
    evidence(spec3, "scope", "F", "charter:v2:retry-path")
    dev3, _ = art("DevReport", "T3", 1, rnd=1, derives=str(spec3))
    crit3, _ = art("Critique", "T3", 1, rnd=1, derives=f"{spec3}, {dev3}",
                   role="crititor")
    evidence(crit3, "AC1", "R", "python3 -m pytest -q tests/t3", fp=fingerprint(),
             sha="cd" * 32, cmd="python3 -m pytest -q tests/t3")
    verdict("PASS", "T3", crit3)
    run(["round", "close", "--mission", M, "--task", "T3", "--n", "1"])
    # trigger: the spec was written after a Charter amendment -> the cell runs
    # between the Crititor PASS and the Stabilizer's accept.
    cell3, _ = art("CalibrationVerdict", "T3", 1, derives=str(ch2), role="arbiter")
    verdict("DRIFT", "T3", cell3, by="arbiter")
    rc, b = run(["calib", "check", "--mission", M])
    check("calib check reports the open task cell",
          rc == 0 and [c["key"] for c in b.get("open_task_drift", [])] == ["T3"],
          str(b)[:400])
    check("the aggregate sequence is still empty at this point",
          b.get("aggregate") == [] and b.get("ok") is True)
    # the DRIFT re-enters the build loop through standing-contract grammar
    run(["round", "open", "--mission", M, "--task", "T3", "--n", "2"])
    crit3b, _ = art("Critique", "T3", 2, rnd=2, derives=f"{spec3}, {dev3}",
                    role="crititor")
    evidence(crit3b, "cell verdict", "D", f"artifact:{cell3}")
    verdict("CHANGES-REQUESTED", "T3", crit3b)
    run(["round", "close", "--mission", M, "--task", "T3", "--n", "2"])
    run(["round", "open", "--mission", M, "--task", "T3", "--n", "3"])
    dev3b, _ = art("DevReport", "T3", 2, rnd=3, derives=str(spec3))
    crit3c, _ = art("Critique", "T3", 3, rnd=3, derives=f"{spec3}, {dev3b}",
                    role="crititor")
    evidence(crit3c, "AC1", "R", "python3 -m pytest -q tests/t3", fp=fingerprint(),
             sha="ef" * 32, cmd="python3 -m pytest -q tests/t3")
    evidence(crit3c, "AC2: cell divergence closed", "F", "charter:v2:retry-path")
    verdict("PASS", "T3", crit3c)
    run(["edge", "add", "--from", str(crit3c), "--to", str(dev3b),
         "--kind", "derives-from"])
    run(["round", "close", "--mission", M, "--task", "T3", "--n", "3"])
    cell3b, _ = art("CalibrationVerdict", "T3", 2, derives=str(ch2),
                    role="arbiter")
    verdict("ALIGNED", "T3", cell3b, by="arbiter")
    rc, b = run(["calib", "check", "--mission", M])
    check("a later ALIGNED closes the task cell",
          rc == 0 and b.get("open_task_drift") == [], str(b)[:300])
    gr3, _ = art("GroupReport", "T3", 1, derives=f"{dev3b}, {crit3c}",
                 role="stabilizer")
    verdict("ACCEPTED", "T3", by="stabilizer")
    note1, _ = art("IntegrationNote", M, 1, derives=f"{gr1}, {gr3}", role="pm")
    run(["edge", "add", "--from", str(note1), "--to", str(gr1),
         "--kind", "carries"])
    run(["edge", "add", "--from", str(note1), "--to", str(gr3),
         "--kind", "carries"])

    print("== L5: the aggregate cell, wave by wave")
    agg1, _ = art("CalibrationVerdict", M, 1, derives=str(ch2), role="arbiter")
    verdict("SUSPICION", "", agg1, by="arbiter")
    rc, b = run(["calib", "check", "--mission", M])
    check("one SUSPICION is a disposition, not an escalation",
          rc == 0 and b.get("ok") is True, str(b.get("findings"))[:300])
    rc, b = run(["flag", "add", "--mission", M, "--kind", "out-of-frame",
                 "--text", "wave 1 cell: authorization chain for the retry"
                           " widening is incomplete"])
    flag1 = b["payload"]["id"]
    agg2, _ = art("CalibrationVerdict", M, 2, derives=str(ch2), role="arbiter")
    verdict("SUSPICION", "", agg2, by="arbiter")
    rc, b = run(["calib", "check", "--mission", M], rc=2)
    check("consecutive SUSPICION fires the ratchet",
          [f["rule"] for f in b.get("findings", [])] == ["suspicion-ratchet"],
          str(b.get("findings"))[:400])
    check("the ratchet names the escalation the PM cannot absorb",
          any("auto-escalate to principal" in f["message"]
              for f in b.get("findings", [])),
          str(b.get("findings"))[:400])
    agg3, _ = art("CalibrationVerdict", M, 3, derives=str(ch2), role="arbiter")
    verdict("DRIFT", "", agg3, by="arbiter")
    rc, b = run(["calib", "check", "--mission", M], rc=2)
    check("DRIFT halts the fan-out",
          [f["rule"] for f in b.get("findings", [])] == ["drift-halt"]
          and any("fan-out halted pending principal disposition" in f["message"]
                  for f in b.get("findings", [])),
          str(b.get("findings"))[:400])
    agg4, _ = art("CalibrationVerdict", M, 4, derives=str(ch2), role="arbiter")
    verdict("ALIGNED", "", agg4, by="arbiter")
    run(["edge", "add", "--from", str(agg4), "--to", str(ch2),
         "--kind", "derives-from"])
    rc, b = run(["calib", "check", "--mission", M])
    check("ALIGNED clears the halt", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:300])
    check("the whole aggregate sequence is on the record",
          [a["kind"] for a in b.get("aggregate", [])]
          == ["SUSPICION", "SUSPICION", "DRIFT", "ALIGNED"],
          str(b.get("aggregate"))[:300])

    print("== calib bundle: the starved seat and the fed seat, by rule")
    rc, cal = run(["calib", "bundle", "--mission", M, "--tasks", "T1,T3",
                   "--seat", "calibrator"])
    check("calibrator gets the delivery set only",
          roles_in(cal) == ["DevReport"], str(roles_in(cal)))
    check("calibrator gets the sealed Charter, current version",
          cal.get("charter", {}).get("version") == 2)
    check("calibrator gets the mechanical metrics, not a narrative",
          cal.get("metrics", {}).get("summary", {}).get("tasks") == 2
          and set(cal["metrics"]["per_task"]) == {"T1", "T3"},
          str(cal.get("metrics"))[:300])
    check("calibrator gets the one-line task list (existence, not content)",
          [t["task"] for t in cal.get("tasks", [])] == ["T1", "T3"]
          and all(t["spec_exists"] for t in cal["tasks"]),
          str(cal.get("tasks"))[:300])
    excl = " | ".join(cal.get("exclusions", []))
    check("what the seat must not receive is named explicitly",
          all(w in excl for w in ("TaskSpec", "Critique", "IntegrationNote",
                                  "CalibrationVerdict", "amendment")), excl[:400])
    check("no critique, spec or note path reaches the starved seat",
          not any(str(p) in json.dumps(cal["files"])
                  for p in ("TaskSpec", "Critique", "IntegrationNote")),
          json.dumps(cal["files"])[:400])
    check("no amendment ledger for the starved seat", "amendments" not in cal)
    rc, chal = run(["calib", "bundle", "--mission", M, "--tasks", "T1,T3",
                    "--seat", "challenger"])
    check("challenger gets everything the calibrator gets, plus the web",
          roles_in(chal) == ["Critique", "DevReport", "IntegrationNote",
                             "TaskSpec"], str(roles_in(chal)))
    check("challenger gets every critique of those tasks",
          len([f for f in chal["files"] if f["role"] == "Critique"]) == 5,
          str([f["artifact"] for f in chal["files"]
               if f["role"] == "Critique"]))
    check("challenger gets the amendment history with the verbatim words",
          [a["version"] for a in chal.get("amendments", [])] == [1, 2]
          and "retry path is in scope"
          in chal["amendments"][1]["verbatim_quote"]
          and chal["amendments"][1]["readback_ref"],
          str(chal.get("amendments"))[:300])
    check("the fed seat has no exclusions", chal.get("exclusions") == [])
    check("both seats read the same delivery set",
          [f["artifact"] for f in cal["files"]]
          == [f["artifact"] for f in chal["files"] if f["role"] == "DevReport"],
          str([f["artifact"] for f in cal["files"]]))

    print("== close: dispositions, retired anchors, the hardened gate")
    rc, b = run(["gate", "close", "--mission", M], rc=2)
    failed = " | ".join(b.get("failures", []))
    check("the gate refuses while the flag and the stale anchor stand",
          "flags-disposed" in failed and "lint-clean" in failed
          and "closing-gate-logged" in failed, failed[:400])
    run(["flag", "dispose", str(flag1), "--disposition",
         "chain completed — amendment v2 authorizes the retry widening",
         "--in", str(note1)])
    # retire the stale anchor the way the law allows: a NEW version carrying the
    # current anchor. Sealed versions are never edited.
    spec1b, _ = art("TaskSpec", "T1", 2, role="architect")
    evidence(spec1b, "scope", "F", "charter:v2:retry-path")
    rc, b = run(["lint", "--mission", M])
    check("re-anchoring on a new version retires the stale finding",
          rc == 0 and b.get("ok") is True, str(b.get("findings"))[:400])
    gfp = fingerprint()
    log = TMP / "closing-gate.log"
    log.write_text("all 2 suites green\n")
    run(["gate", "record", "--mission", M, "--scope", "closing", "--cmd",
         "python3 -m pytest -q", "--log", str(log.relative_to(TMP)),
         "--fingerprint", str(gfp), "--result", "green"])
    rc, b = run(["gate", "close", "--mission", M])
    check("gate close PASSES and closes the mission",
          rc == 0 and b.get("result") == "PASSED" and b.get("closed_at"),
          str(b.get("failures"))[:400])
    check("every closing check is recorded, one by one",
          [c["check"] for c in b.get("checks", [])]
          == ["charter-sealed", "flags-disposed", "closing-gate-logged",
              "source-unchanged", "lint-clean"] and all(c["ok"] for c in
                                                        b["checks"]),
          str(b.get("checks"))[:400])
    rc, b = run(["status"])
    check("the registry shows the mission closed",
          [m for m in b["missions"] if m["name"] == M][0]["status"] == "closed")

    print("== the substrate survives its own dry run")
    rc, b = run(["doctor"])
    check("doctor CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])
    rc, b = run(["rebuild"])
    n_events = b.get("events")
    check("rebuild replays every event", b.get("ok") is True and n_events,
          str(b)[:200])
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
    print("M3 DRY RUN PASSED — L1 prohibition catch, L2 Charter-lint catch, "
          "L3 task cell, L5 ratchet + DRIFT halt, closed through the gate")

if __name__ == "__main__":
    main()
