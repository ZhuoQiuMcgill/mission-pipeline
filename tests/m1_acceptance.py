#!/usr/bin/env python3
"""M1 acceptance gate (DesignDoc_CalibrationAndSubstrate v02, §11):

`mp adopt` on the DIVRA export (433 mission-era artifacts, 7 missions) followed
by `mp metrics` must mechanically reproduce:
  1. the per-mission table in the export's analysis/mission-summary.md, and
  2. every per-task row of analysis/task-rounds.csv for the Week* missions
     (rounds, file counts, outcome, has_task_spec).
Then `mp doctor` must come back CLEAN on the adopted substrate.

Run: python3 tests/m1_acceptance.py
"""
import csv
import io
import json
import os
os.environ['MP_COMPAT_V3'] = '1'  # Explicit released-schema regression; v4 ledgers reject this path.
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MP = str(REPO / "skills" / "mission-pipeline" / "scripts" / "mp")
CORPUS = REPO / "data" / "divra-mission-pipeline-export-2026-08-13.zip"

# analysis/mission-summary.md, hardcoded — the gate's ground truth.
# The `r_other` bucket makes the buckets sum to the task count: Week24 and
# Week25 each carry one spec-only task that the v1.0 table silently dropped.
EXPECTED = {
    "Week21-AutoCloseFix":              {"tasks": 3,  "r1": 3,  "r2": 0, "r3": 0,  "r_other": 0, "escalated": 0},
    "Week22-ExperimentScaleReadiness":  {"tasks": 8,  "r1": 8,  "r2": 0, "r3": 0,  "r_other": 0, "escalated": 0},
    "Week23-SPRHDCalibration":          {"tasks": 8,  "r1": 8,  "r2": 0, "r3": 0,  "r_other": 0, "escalated": 0},
    "Week24-BaselineConsolidation":     {"tasks": 11, "r1": 2,  "r2": 1, "r3": 7,  "r_other": 1, "escalated": 2},
    "Week25-ChannelCampaignReadiness":  {"tasks": 22, "r1": 10, "r2": 7, "r3": 4,  "r_other": 1, "escalated": 6},
    "Week26-SpecifiedExperimentReplay": {"tasks": 12, "r1": 8,  "r2": 4, "r3": 0,  "r_other": 0, "escalated": 2},
    "Week27-CampaignVerificationRepair": {"tasks": 3, "r1": 2,  "r2": 1, "r3": 0,  "r_other": 0, "escalated": 0},
}
EXPECTED_TOTAL = {"tasks": 67, "r1": 41, "r2": 13, "r3": 11, "r_other": 2,
                  "escalated": 10}

FAILS = []

def check(name, cond, detail=""):
    print(("  ok  " if cond else "  FAIL") + f" {name}"
          + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)

def run(args, env, rc=0, json_mode=True):
    cmd = [sys.executable, MP] + (["--json"] if json_mode else []) + args
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env)
    if r.returncode != rc:
        check(f"`mp {' '.join(args)}` rc={rc}", False,
              f"got {r.returncode}: {r.stdout.strip()[:300]} {r.stderr.strip()[:300]}")
        return r.returncode, {}, r.stdout
    body = {}
    if json_mode and r.stdout.strip():
        body = json.loads(r.stdout.strip().splitlines()[-1])
    return r.returncode, body, r.stdout

def main():
    if not CORPUS.exists():
        print(f"FAIL: corpus missing at {CORPUS} — the M1 gate needs the DIVRA export")
        sys.exit(1)
    tmp = Path(tempfile.mkdtemp(prefix="mp-accept-"))
    with zipfile.ZipFile(CORPUS) as z:
        z.extractall(tmp / "corpus")
    ledger_root = tmp / "corpus" / "mp-export" / "ledger"
    proj = tmp / "proj"
    proj.mkdir()
    env = dict(os.environ, MP_ROOT=str(proj), MP_ACTOR="acceptance")

    print("== adopt")
    run(["init"], env)
    rc, b, _ = run(["adopt", str(ledger_root)], env)
    check("adopt ok", b.get("ok") is True)
    check("7 missions adopted", len(b.get("missions", [])) == 7,
          str([m["mission"] for m in b.get("missions", [])]))
    check("no refused events during adopt", b.get("refused") == [],
          str(b.get("refused"))[:300])
    n_artifacts = sum(m["artifacts"] for m in b.get("missions", []))
    print(f"       ({n_artifacts} artifacts, "
          f"{len(b.get('skipped', []))} files skipped)")

    print("== gate 1: mission table reproduces mission-summary.md")
    rc, b, _ = run(["metrics", "--match", "Week*"], env)
    got = b.get("missions", {})
    for m, exp in EXPECTED.items():
        check(f"{m}", got.get(m) == exp, f"expected {exp}, got {got.get(m)}")
    check("Total row", b.get("total") == EXPECTED_TOTAL,
          f"expected {EXPECTED_TOTAL}, got {b.get('total')}")
    t = b.get("total") or {}
    check("the buckets close: r1+r2+r3+other == tasks",
          t.get("tasks") == t.get("r1", 0) + t.get("r2", 0) + t.get("r3", 0)
          + t.get("r_other", 0), str(t))

    print("== gate 2: per-task rows reproduce task-rounds.csv (Week* missions)")
    truth_rows = set()
    with open(tmp / "corpus" / "mp-export" / "analysis" / "task-rounds.csv",
              newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["mission"].startswith("Week"):
                truth_rows.add(tuple(row[k] for k in
                                     ("mission", "task", "rounds", "dev_reports",
                                      "critiques", "group_reports", "outcome",
                                      "has_task_spec")))
    rc, _, outp = run(["metrics", "--match", "Week*", "--tasks-csv"], env,
                      json_mode=False)
    ours_rows = set()
    for row in csv.DictReader(io.StringIO(outp)):
        ours_rows.add(tuple(row[k] for k in
                            ("mission", "task", "rounds", "dev_reports",
                             "critiques", "group_reports", "outcome",
                             "has_task_spec")))
    missing = truth_rows - ours_rows
    extra = ours_rows - truth_rows
    check(f"all {len(truth_rows)} per-task rows match", not missing and not extra,
          f"missing={sorted(missing)[:4]} extra={sorted(extra)[:4]}")

    print("== substrate health after adopt")
    rc, b, _ = run(["doctor"], env)
    check("doctor CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:300])
    rc, b, _ = run(["rebuild"], env)
    check("rebuild ok", b.get("ok") is True)
    rc, b, _ = run(["doctor"], env)
    check("doctor CLEAN after rebuild", rc == 0)

    print()
    if FAILS:
        print(f"ACCEPTANCE: {len(FAILS)} FAILURE(S)")
        sys.exit(1)
    print("ACCEPTANCE: M1 gate PASSED — adopt + metrics reproduce the "
          "seven-mission retrospective mechanically")

if __name__ == "__main__":
    main()
