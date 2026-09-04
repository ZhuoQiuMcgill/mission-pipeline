#!/usr/bin/env python3
"""M2 gate — THE SEAL GATE (v1.1.0).

    a document that breaks an evidence rule is REFUSED at `mp seal`, by name,
    with the fix to make in the document.

v1.0 put the six rules in `mp lint`: a post-hoc report an agent could run, or
not, after typing every fact into the DB by hand. The field typed 1088
`evidence add` calls and zero of eight sampled critiques still agreed with their
own DB rows. v1.1 moves the rules to the one step nobody can skip. Lint stays as
defense in depth for rows the deprecated verbs can still create.

One temp MP_ROOT, one small git repo, two missions built from documents alone:

  Week01-Seal   a wave, a Charter, a spec, a run, a report and a clean critique
                seal by the book; then, one at a time, a document that violates
                each rule is REFUSED and the refusal names the rule:
                  1   a met criterion carrying two D anchors  [evidence-anchoring]
                  2   a met criterion carrying one D anchor   [evidence-anchoring]
                  3   a third D anchor does not upgrade it    [evidence-anchoring]
                  4   an R anchor citing a run that does not exist    [r-anchor]
                  5   a D anchor pointing at a GroupReport  [summary-as-root]
                  6   an F anchor citing a Charter version that does not exist
                                                            [charter-version]
                6'  a STALE charter anchor (v1 after v2) is lawful — it seals,
                    and lands in `mp worklist`, which blocks nothing
  Week02-Gate   the closing gate binds to a RUN of the tree it judged, and fails
                closed when that tree changes underneath it.

Run: python3 tests/m2_lint.py
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

M = "Week01-Seal"
G = "Week02-Gate"
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

def doc(rel, name, **kw):
    fixture(TMP, rel, name, **kw)
    return rel

def seal(rel, rc=0):
    return run(["seal", rel], rc=rc)

def refused_seal(rel, name, **kw):
    """Write a document that breaks a rule, seal it, return the refusal."""
    doc(rel, name, **kw)
    rc, b = seal(rel, rc=3)
    return b.get("reason", "")

def led(mission, fname):
    return f".claude/mission-pipeline/ledger/{mission}/{fname}"

# ---------------------------------------------------------------- the gate

def main():
    global TMP, ENV
    TMP = Path(tempfile.mkdtemp(prefix="mp-m2-"))
    ENV = dict(os.environ, MP_ROOT=str(TMP), MP_ACTOR="crititor:T1")
    g = lambda *a: subprocess.run(["git", "-C", str(TMP)] + list(a),
                                  capture_output=True, text=True)
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (TMP / "src.txt").write_text("hello\n")
    g("add", "-A")
    g("commit", "-qm", "init")
    run(["init"])

    print("== a mission built from documents seals by the book")
    run(["mission", "claim", M, "--cap", "3"])
    run(["wave", "open", "W1", "--mission", M, "--tasks", "T1,T2,T3"])
    rc, b = seal(doc(led(M, "Charter_v01.md"), "charter", mission=M, version=1,
                     derives="none", goal="a loader that never lies",
                     prohibitions="- never widen a test's tolerance to make it"
                                  " pass\n- never ship a migration without a"
                                  " rollback",
                     amendments="| v1 | 2026-09-04 | (initial seal) | — |"))
    charter, contract1 = b["artifact"]["id"], b["contracts"][0]["id"]
    check("the Charter's prohibitions ratify themselves into contracts",
          len(b["contracts"]) == 2 and b["charter"]["version"] == 1,
          str(b.get("contracts"))[:200])
    rc, b = seal(doc(led(M, "TaskSpec_T1_v01.md"), "taskspec", mission=M,
                     key="T1", version=1, wave="W1", recovers="",
                     touches="yes", derives=f"artifact:{charter}",
                     objective="load the config once",
                     ac1="the loader reads the env exactly once",
                     out_of_scope="- the retry path"))
    spec = b["artifact"]["id"]
    check("the spec registers, and its derives-from becomes an edge",
          [e["to"] for e in b["edges"]] == [charter], str(b["edges"]))
    (TMP / "suite.log").write_text("42 passed\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", "suite.log"])
    run1 = b["id"]
    check("a run is recorded against the tree it judged",
          b.get("existing") is False and b.get("tree_hash"), str(b)[:200])
    rc, b = seal(doc(led(M, "DevReport_T1_r1_v01.md"), "devreport", mission=M,
                     key="T1", round=1, version=1, derives=f"artifact:{spec}",
                     summary="one read, cached",
                     runs=f"| run:{run1} | python3 -m pytest -q | 42 passed |",
                     noticed="- None", relay=""))
    dev = b["artifact"]["id"]
    check("the DevReport derives its round from the header",
          [r["n"] for r in b["rounds"]] == [1], str(b["rounds"]))
    rc, b = seal(doc(led(M, "Critique_T1_r1_v01.md"), "critique", mission=M,
                     key="T1", round=1, version=1,
                     derives=f"artifact:{spec}, artifact:{dev}",
                     verdict="PASS",
                     criteria=(f"| 1 | the loader reads the env once | met |"
                               f" run:{run1} | R |\n"
                               f"| 2 | the tolerance is untouched | met |"
                               f" contract:{contract1} | F |\n"
                               f"| 3 | the design still hangs together |"
                               f" partial | artifact:{spec}:objective | D |"),
                     risk="- None", relay=""))
    crit = b["artifact"]["id"]
    check("a critique derives its verdict, evidence and flags in one call",
          len(b["evidence"]) == 3 and b["verdicts"][0]["kind"] == "PASS"
          and b["flags"] == [], str(b)[:300])
    rc, b = seal(doc(led(M, "GroupReport_T1_v01.md"), "groupreport", mission=M,
                     key="T1", version=1,
                     derives=f"artifact:{dev}, artifact:{crit}",
                     outcome="ACCEPTED", reasoning="round 1, clean"))
    group = b["artifact"]["id"]
    rc, b = run(["lint", "--mission", M])
    check("the mission lints CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])

    # ------------------------------------------------------------ the rules
    # Every violation below is written to the SAME path: each one is refused,
    # so nothing is registered and the next attempt starts from the same state.
    bad = led(M, "Critique_T2_r1_v01.md")

    def critique(criteria, **kw):
        kw.setdefault("verdict", "PASS")
        kw.setdefault("risk", "- None")
        return dict(mission=M, key="T2", round=1, version=1,
                    derives=f"artifact:{spec}", criteria=criteria, relay="",
                    **kw)

    print("== rule 1: D + D agreement is worth zero")
    r = refused_seal(bad, "critique", **critique(
        f"| 1 | the seam holds | met | artifact:{spec}:objective | D |\n"
        f"| 1 |  | met | artifact:{dev}:runs | D |"))
    check("two D anchors under one met criterion are REFUSED"
          " [evidence-anchoring]",
          "[evidence-anchoring]" in r and "D,D" in r, r[:300])
    check("the refusal says what to write instead",
          "run:<id>" in r and "charter:v<N>" in r, r[:300])

    print("== rule 2: a criterion marked met needs an R or F anchor")
    r = refused_seal(bad, "critique", **critique(
        f"| 1 | the seam holds | met | artifact:{spec}:objective | D |"))
    check("a lone D anchor under a met criterion is REFUSED"
          " [evidence-anchoring]",
          "[evidence-anchoring]" in r and "echoes are not evidence" in r, r[:300])

    print("== rule 3: D never upgrades")
    r = refused_seal(bad, "critique", **critique(
        f"| 1 | the seam holds | met | artifact:{spec}:objective | D |\n"
        f"| 1 |  | met | artifact:{dev}:runs | D |\n"
        f"| 1 |  | met | artifact:{crit}:verdict | D |"))
    check("a third D anchor does not upgrade the chain [evidence-anchoring]",
          "[evidence-anchoring]" in r and "D,D,D" in r, r[:300])
    rc, b = seal(doc(bad, "critique", **critique(
        f"| 1 | the seam holds | met | run:{run1} | R |\n"
        f"| 1 |  | met | artifact:{spec}:objective | D |")), rc=0)
    check("the same criterion seals once ONE reality anchor is present",
          b.get("ok") is True and len(b["evidence"]) == 2, str(b)[:200])
    run(["supersede", f"artifact:{b['artifact']['id']}", "--by", "reality",
         "--reason", "seeded fixture, retired so the path is free"])

    print("== rule 4: R binds to the source state that produced it")
    bad3 = led(M, "Critique_T3_r1_v01.md")

    def critique3(criteria, **kw):
        kw.setdefault("verdict", "PASS")
        kw.setdefault("risk", "- None")
        return dict(mission=M, key="T3", round=1, version=1,
                    derives=f"artifact:{spec}", criteria=criteria, relay="",
                    **kw)

    r = refused_seal(bad3, "critique", **critique3(
        "| 1 | the suite is green | met | run:9999 | R |"))
    check("an R anchor citing a run that does not exist is REFUSED [r-anchor]",
          "[r-anchor]" in r and "no run 9999" in r, r[:300])
    check("the refusal names the command that would fix it",
          "mp run record" in r, r[:300])
    r = refused_seal(bad3, "critique", **critique3(
        "| 1 | the suite is green | met | python3 -m pytest -q | R |"))
    check("an R anchor that is prose rather than `run:<id>` is REFUSED",
          "[r-anchor]" in r and "run:<id>" in r, r[:300])

    print("== rule 5: summaries are never citable roots")
    r = refused_seal(bad3, "critique", **critique3(
        f"| 1 | the wave integrated | met | run:{run1} | R |\n"
        f"| 2 | the group accepted | met | artifact:{group} | D |\n"
        f"| 2 |  | met | run:{run1} | R |"))
    check("a D anchor pointing at a GroupReport is REFUSED [summary-as-root]",
          "[summary-as-root]" in r and "GroupReport" in r, r[:300])
    check("the refusal says to cite what the summary carries",
          "cite the artifact the summary carries" in r, r[:300])

    print("== rule 6: an F anchor cannot cite a Charter that does not exist")
    r = refused_seal(bad3, "critique", **critique3(
        "| 1 | in scope | met | charter:v9:prohibition-1 | F |"))
    check("a forward Charter anchor is REFUSED [charter-version]",
          "[charter-version]" in r and "is at v1" in r, r[:300])

    print("== rule 6': a STALE anchor is lawful — it seals, and goes to the"
          " worklist")
    rc, b = seal(doc(bad3, "critique", **critique3(
        "| 1 | in scope | met | charter:v1:prohibition-1 | F |")))
    stale_crit = b["artifact"]["id"]
    check("a critique anchored at the current Charter seals", b.get("ok") is True)
    rc, b = seal(doc(led(M, "Charter_v02.md"), "charter", mission=M, version=2,
                     derives=f"artifact:{charter}",
                     goal="a loader that never lies",
                     prohibitions="- never widen a test's tolerance to make it"
                                  " pass\n- never ship a migration without a"
                                  " rollback",
                     amendments="| v1 | 2026-09-04 | (initial seal) | — |\n"
                                "| v2 | 2026-09-04 | the retry path is in scope"
                                " after all | read-back 2026-09-04 #2 |"))
    check("the Charter re-issues to v2 with the principal's words",
          b["charter"]["version"] == 2
          and "retry path is in scope" in b["charter"]["quote"], str(b)[:300])
    rc, b = run(["lint", "--mission", M])
    check("the stale anchor is NOT a lint finding any more",
          rc == 0 and b.get("ok") is True, str(b.get("findings"))[:400])
    rc, b = run(["worklist", "--mission", M])
    items = [i for i in b.get("items", [])
             if i["kind"] == "stale-charter-anchor"]
    check("it is a worklist item instead",
          [i["artifact"] for i in items] == [stale_crit], str(b.get("items"))[:400])
    check("the worklist says it is lawful and blocks nothing",
          rc == 0 and "lawful" in items[0]["message"]
          and b.get("owner") == "pm", str(items)[:300])

    print("== the structural rules the field never fired")
    r = refused_seal(led(M, "DevReport_T1_r4_v01.md"), "devreport", mission=M,
                     key="T1", round=4, version=1, derives="none",
                     summary="a fourth round", runs="| None | — | — |",
                     noticed="- None", relay="")
    check("round 4 under a cap of 3 is REFUSED [round-cap]",
          "[round-cap]" in r and "cap is 3" in r, r[:300])
    r = refused_seal(led(M, "TaskSpec_T4_v01.md"), "taskspec", mission=M,
                     key="T4", version=1, wave="W1", recovers="",
                     touches="no", derives="none", objective="something",
                     ac1="it works", out_of_scope="- None")
    check("a spec whose out-of-scope list says only None is REFUSED"
          " [out-of-scope]",
          "[out-of-scope]" in r and "invariant 5" in r, r[:300])
    r = refused_seal(led(M, "TaskSpec_T5_v01.md"), "taskspec", mission=M,
                     key="T5", version=1, wave="W7", recovers="",
                     touches="no", derives="none", objective="something",
                     ac1="it works", out_of_scope="- the retry path")
    check("a spec naming a wave nobody opened is REFUSED [wave-open]",
          "[wave-open]" in r and "mp wave open W7" in r, r[:300])
    r = refused_seal(led(M, "Critique_T1_r1_v02.md"), "critique", mission=M,
                     key="T1", round=1, version=1, derives="none",
                     verdict="PASS", risk="- None", relay="",
                     criteria=f"| 1 | x | met | run:{run1} | R |")
    check("re-sealing a sealed version is REFUSED [immutability]",
          "[immutability]" in r and "bump `version:` to 2" in r, r[:300])

    print("== gate close: bound to a run of the judged tree, failing closed")
    run(["mission", "claim", G])
    run(["wave", "open", "W1", "--mission", G, "--tasks", "T1"])
    rc, b = run(["gate", "close", "--mission", G], rc=2)
    failed = " | ".join(b.get("failures", []))
    check("close refuses with no Charter and no closing run",
          b.get("result") == "FAILED" and "charter-sealed" in failed
          and "closing-gate-logged" in failed, failed[:400])
    rc, b = seal(doc(led(G, "Charter_v01.md"), "charter", mission=G, version=1,
                     derives="none", goal="ship it",
                     prohibitions="- never weaken the closing gate",
                     amendments="| v1 | 2026-09-04 | (initial seal) | — |"))
    gcharter = b["artifact"]["id"]
    rc, b = seal(doc(led(G, "TaskSpec_T1_v01.md"), "taskspec", mission=G,
                     key="T1", version=1, wave="W1", recovers="", touches="no",
                     derives=f"artifact:{gcharter}", objective="ship",
                     ac1="the suite is green", out_of_scope="- the CLI"))
    gspec = b["artifact"]["id"]
    rc, b = seal(doc(led(G, "DevReport_T1_r1_v01.md"), "devreport", mission=G,
                     key="T1", round=1, version=1,
                     derives=f"artifact:{gspec}", summary="shipped",
                     runs=f"| run:{run1} | python3 -m pytest -q | 42 passed |",
                     noticed="- the retry path is untested", relay=""))
    gdev, gflag = b["artifact"]["id"], b["flags"][0]["id"]
    check("the DevReport's 'noticed but not fixed' bullet became the flag",
          b["flags"][0]["text"] == "the retry path is untested",
          str(b["flags"])[:200])
    rc, b = run(["gate", "close", "--mission", G], rc=2)
    check("the open flag blocks the close (invariant 11)",
          any("flags-disposed" in f for f in b.get("failures", [])),
          str(b.get("failures"))[:300])
    rc, b = seal(doc(led(G, "IntegrationNote_W1_v01.md"), "integrationnote",
                     mission=G, version=1, wave="W1",
                     derives=f"artifact:{gdev}",
                     regrounding="wave 1 delivers the loader",
                     flags=(f"| {gflag} | the retry path is untested |"
                            f" artifact:{gdev} | accepted risk — the retry path"
                            f" lands in Week03 |"),
                     compaction="no", relay=""))
    check("the Integration Note's flag ledger disposes it and closes the wave",
          [d["id"] for d in b["dispositions"]] == [gflag]
          and b["wave_close"]["compaction"] == "no", str(b)[:300])
    (TMP / "gate.log").write_text("43 passed\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", "gate.log", "--scope", "closing", "--mission", G])
    closing = b["id"]
    (TMP / "src.txt").write_text("hello\nand a quiet change after the gate\n")
    rc, b = run(["gate", "close", "--mission", G], rc=2)
    check("source drift after the run fails the gate closed",
          b.get("result") == "FAILED"
          and any("source drifted since the gate ran — fail closed" in f
                  for f in b.get("failures", [])),
          str(b.get("failures"))[:400])
    check("only the drift check failed", len(b.get("failures", [])) == 1,
          str(b.get("failures"))[:400])
    rc, b = run(["status"])
    check("the mission stayed open",
          [m for m in b["missions"] if m["name"] == G][0]["status"] == "open")
    (TMP / "gate2.log").write_text("44 passed\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", "gate2.log", "--scope", "closing", "--mission", G])
    check("the re-run is a NEW run — a different tree is a different fact",
          b["id"] != closing and b.get("existing") is False, str(b)[:200])
    rc, b = run(["gate", "close", "--mission", G])
    check("gate close PASSES once the gate ran over the current source",
          rc == 0 and b.get("result") == "PASSED" and b.get("closed_at"),
          str(b.get("failures"))[:400])
    check("all five checks passed",
          [c["check"] for c in b.get("checks", []) if c["ok"]]
          == ["charter-sealed", "flags-disposed", "closing-gate-logged",
              "source-unchanged", "lint-clean"], str(b.get("checks"))[:400])

    print("== the whole gate replays")
    rc, b = run(["rebuild"])
    check("rebuild ok", b.get("ok") is True and not b.get("replay_skips"),
          str(b)[:300])
    rc, b = run(["doctor"])
    check("doctor CLEAN after replaying every sealed document", rc == 0,
          str(b.get("findings"))[:400])
    rc, b = run(["lint", "--mission", M])
    check("lint still CLEAN on the rebuilt DB", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])

    print()
    if FAILS:
        print(f"M2: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("M2 SEAL GATE PASSED — every evidence rule is refused at the door,"
          " by name; stale is a worklist item; the closing gate binds to the"
          " run of the tree it judged")

if __name__ == "__main__":
    main()
