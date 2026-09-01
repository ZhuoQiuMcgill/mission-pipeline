#!/usr/bin/env python3
"""M2 gate (DesignDoc_CalibrationAndSubstrate v02, §11):

    `mp lint` catches seeded violations of each of the six evidence rules.

One temp MP_ROOT, one small git repo, three missions built through `mp` alone:

  Week01-Clean  a mission built by the book — lints CLEAN.
  Week01-Seed   one seeded violation per rule, each asserted by rule name:
                  1+2+3  a PASS-verdicted critique whose criterion carries only
                         D evidence (and a second D row does not help — D+D
                         agreement is worth zero)                evidence-anchoring
                  4      `evidence add --type R` without --fingerprint is REFUSED
                         at the write path; an R row that lost its binding via an
                         out-of-path sqlite INSERT (seeded into a throwaway COPY
                         of the root) is caught by lint                r-integrity
                  5      D evidence anchored at a GroupReport      summary-as-root
                  6a     an F anchor `charter:v1` after the Charter amends to v2
                                                                    stale-charter
                  6b     an edge citing v1 of a document whose v2 exists
                                                                   stale-citation
                plus header/registry disagreement              header-consistency
  Week02-Gate   the hardened close: `mp gate close` fails closed when a tracked
                source file changed after the closing gate was recorded, and
                passes end to end once the gate is re-recorded with a fresh
                fingerprint and log.

Run: python3 tests/m2_lint.py
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MP = str(REPO / "skills" / "mission-pipeline" / "scripts" / "mp")

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

# ---------------------------------------------------------------- fixtures

def header(mission, cat, key, rnd, ver, derives="none"):
    return ("<!-- mp:header\n"
            f"mission: {mission}\n"
            f"category: {cat}\n"
            f"key: {key}\n"
            f"round: {rnd}\n"
            f"version: {ver}\n"
            f"derives-from: {derives}\n"
            "-->\n")

def artifact(mission, cat, key, ver, rnd=0, derives="none", role="constructor"):
    """Write the file (with its machine-readable header) and register it."""
    p = (TMP / ".claude" / "mission-pipeline" / "ledger" / mission
         / f"{cat}_{key}_r{rnd}_v{ver:02d}.md")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(header(mission, cat, key, rnd, ver, derives)
                 + f"# {cat} — {key} v{ver}\n\nbody\n", encoding="utf-8")
    rc, b = run(["artifact", "new", "--mission", mission, "--category", cat,
                 "--key", key, "--round", str(rnd), "--version", str(ver),
                 "--path", str(p.relative_to(TMP)), "--author-role", role])
    return b["payload"]["id"], p

def lint(mission=None, rc=0, env=None):
    args = ["lint"] + (["--mission", mission] if mission else [])
    return run(args, rc=rc, env=env)

def rules(body):
    return sorted({f["rule"] for f in body.get("findings", [])})

def msgs(body, rule):
    return [f["message"] for f in body.get("findings", []) if f["rule"] == rule]

# ---------------------------------------------------------------- the gate

def main():
    global TMP, ENV
    TMP = Path(tempfile.mkdtemp(prefix="mp-m2-"))
    ENV = dict(os.environ, MP_ROOT=str(TMP), MP_ACTOR="m2")
    g = lambda *a: subprocess.run(["git", "-C", str(TMP)] + list(a),
                                  capture_output=True, text=True)
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (TMP / "src.txt").write_text("hello\n")
    g("add", "-A")
    g("commit", "-qm", "init")
    run(["init"])

    # ------------------------------------------------------------ clean
    print("== a mission built by the book lints CLEAN")
    M = "Week01-Clean"
    run(["mission", "claim", M])
    ch = TMP / ".claude" / "mission-pipeline" / "ledger" / M / "Charter.md"
    ch.parent.mkdir(parents=True, exist_ok=True)
    ch.write_text(header(M, "Charter", M, 0, 1)
                  + "# Charter\nnever weaken the closing gate\n", encoding="utf-8")
    run(["charter", "seal", "--mission", M, "--path", str(ch.relative_to(TMP))])
    spec, _ = artifact(M, "TaskSpec", "T1", 1, role="architect")
    dev, _ = artifact(M, "DevReport", "T1", 1, rnd=1, derives=str(spec))
    crit, critp = artifact(M, "Critique", "T1", 1, rnd=1,
                           derives=f"{spec}, {dev}", role="crititor")
    rc, b = run(["fingerprint", "take"])
    fp1 = b["payload"]["id"]
    run(["evidence", "add", "--artifact", str(crit), "--criterion", "AC1",
         "--type", "R", "--anchor", "python3 -m pytest -q tests/test_x.py",
         "--cmd", "python3 -m pytest -q", "--output-sha", "beef" * 8,
         "--fingerprint", str(fp1)])
    run(["evidence", "add", "--artifact", str(crit), "--criterion", "AC2",
         "--type", "F", "--anchor", "charter:v1:prohibition-1"])
    run(["verdict", "record", "--mission", M, "--task", "T1", "--artifact",
         str(crit), "--kind", "PASS", "--by", "crititor"])
    run(["edge", "add", "--from", str(crit), "--to", str(spec), "--kind", "cites"])
    run(["edge", "add", "--from", str(crit), "--to", str(dev),
         "--kind", "derives-from"])
    run(["artifact", "seal", str(crit)])
    rc, b = lint(M)
    check("clean mission lints CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])

    print("== edge add validates")
    rc, b = run(["edge", "add", "--from", str(crit), "--to", str(spec),
                 "--kind", "cites"], rc=3)
    check("duplicate edge REFUSED", b.get("refused") is True)
    rc, b = run(["edge", "add", "--from", "9999", "--to", str(spec),
                 "--kind", "cites"], rc=3)
    check("edge to unknown artifact REFUSED", b.get("refused") is True)

    # ------------------------------------------------------------ seeds
    print("== rules 1+2+3: an acceptance resting only on derived documents")
    S = "Week01-Seed"
    run(["mission", "claim", S])
    sch = TMP / ".claude" / "mission-pipeline" / "ledger" / S / "Charter.md"
    sch.parent.mkdir(parents=True, exist_ok=True)
    sch.write_text(header(S, "Charter", S, 0, 1) + "# Charter\nv1 text\n",
                   encoding="utf-8")
    run(["charter", "seal", "--mission", S, "--path", str(sch.relative_to(TMP))])
    s2spec, _ = artifact(S, "TaskSpec", "T2", 1, role="architect")
    s2dev, _ = artifact(S, "DevReport", "T2", 1, rnd=1, derives=str(s2spec))
    s2crit, _ = artifact(S, "Critique", "T2", 1, rnd=1, derives=str(s2spec),
                         role="crititor")
    run(["evidence", "add", "--artifact", str(s2crit), "--criterion", "AC1",
         "--type", "D", "--anchor", f"artifact:{s2dev}:section-3"])
    run(["verdict", "record", "--mission", S, "--task", "T2", "--artifact",
         str(s2crit), "--kind", "PASS", "--by", "crititor"])
    rc, b = lint(S, rc=2)
    check("D-only criterion flagged [evidence-anchoring]",
          "evidence-anchoring" in rules(b), str(rules(b)))
    check("finding says echoes are not evidence",
          any("echoes are not evidence" in m
              for m in msgs(b, "evidence-anchoring")),
          str(msgs(b, "evidence-anchoring"))[:300])
    run(["evidence", "add", "--artifact", str(s2crit), "--criterion", "AC1",
         "--type", "D", "--anchor", f"artifact:{s2spec}"])
    rc, b = lint(S, rc=2)
    check("a second D row is still a finding (D+D = zero weight)",
          any("types: D,D" in m for m in msgs(b, "evidence-anchoring")),
          str(msgs(b, "evidence-anchoring"))[:300])

    print("== rule 4: R binds to source state")
    rc, b = run(["evidence", "add", "--artifact", str(s2dev), "--criterion",
                 "AC9", "--type", "R", "--anchor", "pytest -q",
                 "--output-sha", "dead" * 8], rc=3)
    check("R without --fingerprint REFUSED at the write path",
          b.get("refused") is True and "fingerprint" in b.get("reason", ""),
          b.get("reason", ""))
    copy = Path(str(TMP) + "-copy")
    if copy.exists():
        shutil.rmtree(copy)
    shutil.copytree(TMP, copy)  # throwaway: never write the DB of a live root
    cenv = dict(os.environ, MP_ROOT=str(copy), MP_ACTOR="m2")
    with sqlite3.connect(copy / ".claude" / "mission-pipeline" / "ledger"
                         / "mp.db") as db:
        db.execute("INSERT INTO evidence (artifact,criterion,type,anchor,cmd,"
                   "output_sha,fingerprint_id) VALUES (?,?,?,?,?,?,?)",
                   (s2dev, "AC9", "R", "pytest -q", "pytest -q", None, None))
    rc, b = lint(S, rc=2, env=cenv)
    check("unbound R row caught on the copy [r-integrity]",
          "r-integrity" in rules(b), str(rules(b)))
    check("r-integrity names the bypass",
          any("outside the write path" in m for m in msgs(b, "r-integrity")),
          str(msgs(b, "r-integrity"))[:300])
    rc, b = lint(S, rc=2)
    check("the live root is untouched by the seeded copy",
          "r-integrity" not in rules(b), str(rules(b)))
    shutil.rmtree(copy)

    print("== rule 5: summaries are never citable roots")
    s5gr, _ = artifact(S, "GroupReport", "T5", 1, role="stabilizer")
    s5crit, _ = artifact(S, "Critique", "T5", 1, rnd=1, role="crititor")
    run(["evidence", "add", "--artifact", str(s5crit), "--criterion", "AC1",
         "--type", "D", "--anchor", f"artifact:{s5gr}"])
    rc, b = lint(S, rc=2)
    check("D anchored at a GroupReport flagged [summary-as-root]",
          "summary-as-root" in rules(b), str(rules(b)))
    check("finding says summaries are never citable roots",
          any("summaries are never citable roots" in m
              for m in msgs(b, "summary-as-root")),
          str(msgs(b, "summary-as-root"))[:300])

    print("== rule 6a: a Charter amendment propagates staleness")
    s6spec, _ = artifact(S, "TaskSpec", "T6", 1, role="architect")
    run(["evidence", "add", "--artifact", str(s6spec), "--criterion",
         "scope-bound", "--type", "F", "--anchor", "charter:v1:line-4"])
    rc, b = lint(S, rc=2)
    check("charter:v1 is not stale while the Charter is at v1",
          "stale-charter" not in rules(b), str(rules(b)))
    sch.write_text(header(S, "Charter", S, 0, 2) + "# Charter\nv2 text\n",
                   encoding="utf-8")
    run(["charter", "amend", "--mission", S, "--path", str(sch.relative_to(TMP)),
         "--quote", "yes — widen T6 to cover the retry path",
         "--readback", "readback-2"])
    rc, b = lint(S, rc=2)
    check("charter:v1 anchor flagged after amend [stale-charter]",
          "stale-charter" in rules(b), str(rules(b)))
    check("stale-charter names the anchor and the current version",
          any("charter:v1" in m and "v2" in m for m in msgs(b, "stale-charter")),
          str(msgs(b, "stale-charter"))[:300])

    print("== rule 6b: citing v1 of a document whose v2 exists")
    s4crit1, _ = artifact(S, "Critique", "T4", 1, rnd=1, role="crititor")
    s4dev, _ = artifact(S, "DevReport", "T4", 1, rnd=1)
    run(["edge", "add", "--from", str(s4dev), "--to", str(s4crit1),
         "--kind", "cites"])
    rc, b = lint(S, rc=2)
    check("citing the only version is not stale",
          "stale-citation" not in rules(b), str(rules(b)))
    artifact(S, "Critique", "T4", 2, rnd=2, role="crititor")
    rc, b = lint(S, rc=2)
    check("edge to a superseded version flagged [stale-citation]",
          "stale-citation" in rules(b), str(rules(b)))
    check("stale-citation names both versions",
          any("v1" in m and "v2 exists" in m for m in msgs(b, "stale-citation")),
          str(msgs(b, "stale-citation"))[:300])

    print("== header ↔ registry agreement")
    _, s6p = artifact(S, "DevPlan", "T6", 1, role="architect")
    rc, b = lint(S, rc=2)
    check("a matching header is not a finding",
          "header-consistency" not in rules(b), str(rules(b)))
    s6p.write_text(header(S, "DevPlan", "T6", 0, 7, derives="4242")
                   + "# quietly renumbered\n", encoding="utf-8")
    rc, b = lint(S, rc=2)
    check("header/registry mismatch flagged [header-consistency]",
          "header-consistency" in rules(b), str(rules(b)))
    check("both the version mismatch and the unknown derives-from id are named",
          any("version='7'" in m for m in msgs(b, "header-consistency"))
          and any("derives-from '4242'" in m
                  for m in msgs(b, "header-consistency")),
          str(msgs(b, "header-consistency"))[:400])
    check("all six rules seeded and caught",
          set(rules(b)) >= {"evidence-anchoring", "summary-as-root",
                            "stale-charter", "stale-citation",
                            "header-consistency"}, str(rules(b)))

    print("== the seeded mission does not contaminate the clean one")
    rc, b = lint(M)
    check("clean mission still lints CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:300])

    # ------------------------------------------------------------ gate close
    print("== gate close: fail closed, then pass end to end")
    G = "Week02-Gate"
    run(["mission", "claim", G])
    artifact(G, "DevReport", "T1", 1, rnd=1)
    rc, b = run(["flag", "add", "--mission", G, "--task", "T1", "--kind",
                 "out-of-frame", "--text", "the retry path is untested"], rc=0)
    fid = b["payload"]["id"]
    rc, b = run(["gate", "close", "--mission", G], rc=2)
    failed = " | ".join(b.get("failures", []))
    check("close refuses with no Charter, an open flag and no gate run",
          b.get("result") == "FAILED"
          and "charter-sealed" in failed and "flags-disposed" in failed
          and "closing-gate-logged" in failed, failed[:400])
    gch = TMP / ".claude" / "mission-pipeline" / "ledger" / G / "Charter.md"
    gch.parent.mkdir(parents=True, exist_ok=True)
    gch.write_text(header(G, "Charter", G, 0, 1) + "# Charter\nship it\n",
                   encoding="utf-8")
    run(["charter", "seal", "--mission", G, "--path", str(gch.relative_to(TMP))])
    run(["flag", "dispose", str(fid), "--disposition",
         "accepted risk — the retry path lands in Week03"])
    rc, b = run(["fingerprint", "take"])
    gfp = b["payload"]["id"]
    log = TMP / "gate.log"
    log.write_text("42 passed\n")
    run(["gate", "record", "--mission", G, "--scope", "closing", "--cmd",
         "python3 -m pytest -q", "--log", "gate.log", "--fingerprint",
         str(gfp), "--result", "green"])
    (TMP / "src.txt").write_text("hello\nand a quiet change after the gate\n")
    rc, b = run(["gate", "close", "--mission", G], rc=2)
    check("source drift after the gate fails closed",
          b.get("result") == "FAILED"
          and any("source drifted since the gate ran — fail closed" in f
                  for f in b.get("failures", [])),
          str(b.get("failures"))[:400])
    check("only the drift check failed", len(b.get("failures", [])) == 1,
          str(b.get("failures"))[:400])
    rc, b = run(["status"])
    check("the mission stayed open",
          [m for m in b["missions"] if m["name"] == G][0]["status"] == "open")
    rc, b = run(["fingerprint", "take"])
    gfp2 = b["payload"]["id"]
    log2 = TMP / "gate2.log"
    log2.write_text("43 passed\n")
    run(["gate", "record", "--mission", G, "--scope", "closing", "--cmd",
         "python3 -m pytest -q", "--log", "gate2.log", "--fingerprint",
         str(gfp2), "--result", "green"])
    rc, b = run(["gate", "close", "--mission", G])
    check("gate close PASSES once the gate is re-run over the current source",
          rc == 0 and b.get("result") == "PASSED" and b.get("closed_at"),
          str(b.get("failures"))[:400])
    check("all five checks passed",
          [c["check"] for c in b.get("checks", []) if c["ok"]]
          == ["charter-sealed", "flags-disposed", "closing-gate-logged",
              "source-unchanged", "lint-clean"], str(b.get("checks"))[:400])
    rc, b = run(["status"])
    check("the mission is closed",
          [m for m in b["missions"] if m["name"] == G][0]["status"] == "closed")
    rc, b = run(["gate", "close", "--mission", G], rc=2)
    check("closing a closed mission fails, journaled",
          b.get("result") == "FAILED" and "already closed"
          in (b.get("close_refused") or ""), str(b)[:300])

    print("== the gate is journaled and replays identically")
    jl = [json.loads(l) for l in
          (TMP / ".claude" / "mission-pipeline" / "ledger"
           / "events.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    checks = [e for e in jl if e["action"] == "gate.check"]
    check("gate.check events journaled with their verdict",
          len(checks) == 4
          and [e["payload"]["result"] for e in checks]
          == ["FAILED", "FAILED", "PASSED", "PASSED"],
          str([e["payload"]["result"] for e in checks]))
    check("a FAILED gate.check carries its failures in the payload",
          checks[1]["payload"]["failures"] and
          "source drifted" in checks[1]["payload"]["failures"][0])
    check("edge.add is journaled", any(e["action"] == "edge.add" for e in jl))
    rc, b = run(["rebuild"])
    check("rebuild ok", b.get("ok") is True)
    rc, b = run(["doctor"])
    check("doctor CLEAN after replaying the new actions", rc == 0,
          str(b.get("findings"))[:400])
    rc, b = lint(M)
    check("lint still CLEAN on the rebuilt DB", rc == 0 and b.get("ok") is True)

    print()
    if FAILS:
        print(f"M2: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("M2 GATE PASSED — mp lint catches a seeded violation of each of the "
          "six evidence rules, and the closing gate fails closed on source drift")

if __name__ == "__main__":
    main()
