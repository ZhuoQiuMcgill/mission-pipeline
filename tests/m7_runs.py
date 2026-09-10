#!/usr/bin/env python3
"""M7 gate — WHAT A RUN ROW SAYS (new at v1.2.0).

Nine of the field's twenty-nine relay items were about `mp run record`, and all
of them were the same complaint from different seats: the row did not say enough
for anyone else to use it.

  --result pass|fail|mixed   the column was NULL on every row a seat inspected,
                             so reading a verification meant opening its log
                             (relay 22/25/27). Absent, mp now warns.
  --expect fail              a fail-before batch and a pass-after batch were the
                             same kind of row, and only the log told them apart
                             (relay 6/8). An expect-fail run is never a passing
                             anchor — refused at seal, caught again by lint.
  --commit <sha>             a run judged an earlier commit of a tree that has
                             since moved could not be recorded truthfully, so
                             the figure was cited as prose and the evidence law
                             lost an R anchor (relay 5). The binding is DECLARED.
  a script path as --cmd     a verification that stands two planes up, migrates
                             them, runs several suites and tears them down is a
                             script; its hash is recorded so a later seat can
                             re-run exactly what ran (relay 10/14).
  scope in the identity      a deterministic gate produces byte-identical
                             output, so the closing-scope record of an already
                             recorded task run was refused as a duplicate and
                             the only way through was to corrupt the command
                             text with a comment (relay 28).
  git_tree                   a project rule told seats to compare a row against
                             `git rev-parse HEAD^{tree}`; mp stored a content
                             fingerprint, so the two could never be equal and
                             the rule was unexecutable as written (relay 7/11/26).
  run list / run show        and now you can read the table.

Run: python3 tests/m7_runs.py
"""
import json
import os
os.environ['MP_COMPAT_V3'] = '1'  # Explicit released-schema regression; v4 ledgers reject this path.
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MP = str(REPO / "skills" / "mission-pipeline" / "scripts" / "mp")
sys.dont_write_bytecode = True  # no __pycache__ in the working tree
sys.path.insert(0, str(REPO / "tests" / "fixtures"))
from docs import write as fixture  # noqa: E402

M = "Week08-Runs"
FAILS = []
ENV = {}
TMP = None


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


def seal(fname, kind, rc=0, **kw):
    kw.setdefault("mission", M)
    fixture(TMP, led(fname), kind, **kw)
    return run(["seal", led(fname)], rc=rc)


def log(name, text):
    """Logs live under the ledger — pipeline state, which a tree fingerprint
    ignores by design, so recording a run never dirties the tree it judged."""
    p = TMP / ".claude" / "mission-pipeline" / "ledger" / "logs" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return str(p.relative_to(TMP))


def git(*a):
    return subprocess.run(["git", "-C", str(TMP)] + list(a),
                          capture_output=True, text=True, encoding="utf-8").stdout.strip()


# ---------------------------------------------------------------- the gate

def main():
    global TMP, ENV
    TMP = Path(tempfile.mkdtemp(prefix="mp-m7-"))
    ENV = dict(os.environ, MP_ROOT=str(TMP), MP_ACTOR="constructor:T1")
    git("init", "-q")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    (TMP / "src.txt").write_text("the toy project\n")
    ops = TMP / "ops"
    ops.mkdir()
    (ops / "verify.sh").write_text(
        "#!/bin/sh\nset -e\n# stand the planes up, migrate, run, tear down\n"
        "echo verifying\n")
    git("add", "-A")
    git("commit", "-qm", "init")
    run(["init"])

    print("== a mission, from its Charter")
    rc, b = seal("Charter_v01.md", "charter", version=1, derives="none",
                 goal="a verification any seat can read off the row",
                 prohibitions="- never cite a run you cannot re-run",
                 amendments="| v1 | 2026-09-05 | (initial seal) | — |")
    charter = b["artifact"]["id"]
    run(["wave", "open", "W1", "--mission", M, "--tasks", "T1"])
    rc, b = seal("TaskSpec_T1_v01.md", "taskspec", key="T1", version=1,
                 wave="W1", recovers="", touches="no",
                 derives=f"artifact:{charter}", objective="verify honestly",
                 ac1="the suite is green", out_of_scope="- the CLI")
    spec = b["artifact"]["id"]

    print("== --result: the row, not the log, is what the next seat reads")
    green_log = log("green.log", "42 passed\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", green_log, "--mission", M])
    silent = b["id"]
    check("a run with no --result is recorded, and WARNS",
          b["result"] == "" and "no --result recorded" in b.get("warning", ""),
          str(b)[:400])
    green2_log = log("green2.log", "43 passed\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", green2_log, "--result", "pass", "--mission", M])
    passing = b["id"]
    check("with --result the row says so, and there is no warning",
          b["result"] == "pass" and "warning" not in b, str(b)[:400])
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", green2_log, "--result", "green"], rc=2)
    check("a result outside pass|fail|mixed is rejected by the parser",
          rc == 2, str(b)[:200])

    print("== git_tree: git's own id, beside the content fingerprint")
    want = git("rev-parse", "HEAD^{tree}")
    rc, b = run(["run", "show", str(passing)])
    check("a clean tree records `git rev-parse HEAD^{tree}` as well",
          b["git_tree"] == want and b["dirty"] == 0
          and b["tree_hash"] != b["git_tree"],
          f"git_tree={b.get('git_tree')} want={want}")
    (TMP / "dirty.txt").write_text("uncommitted\n")
    d_log = log("d.log", "44 passed, dirty tree\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q", "--log",
                 d_log, "--result", "pass", "--mission", M])
    check("a dirty tree records no git tree id — there is no honest one",
          b["git_tree"] is None and b["dirty"] == 1, str(b)[:300])
    (TMP / "dirty.txt").unlink()

    print("== a script path is a legal command, and its hash goes with it")
    import hashlib
    want_sha = hashlib.sha256((ops / "verify.sh").read_bytes()).hexdigest()
    ops_log = log("ops.log", "verifying\n")
    rc, b = run(["run", "record", "--cmd", "ops/verify.sh", "--log", ops_log,
                 "--result", "pass", "--mission", M])
    script_run = b["id"]
    check("`--cmd ops/verify.sh` records the script's sha256",
          b["cmd_sha"] == want_sha, f"{b.get('cmd_sha')} != {want_sha}")
    ops2_log = log("ops2.log", "verifying, with an argument\n")
    rc, b = run(["run", "record", "--cmd", "ops/verify.sh --full",
                 "--log", ops2_log, "--result", "pass", "--mission", M])
    check("and so does a script with arguments",
          b["cmd_sha"] == want_sha, str(b.get("cmd_sha")))
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q -k nothing",
                 "--log", ops2_log, "--result", "pass", "--mission", M])
    check("a command that is not a file records no hash",
          b["cmd_sha"] is None, str(b.get("cmd_sha")))

    print("== scope joins the run's identity (relay 28)")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", green2_log, "--result", "pass", "--mission", M])
    check("the same tree, command, output and scope CITES the first run",
          b.get("existing") is True and b["id"] == passing, str(b)[:300])
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", green2_log, "--scope", "closing", "--result",
                 "pass", "--mission", M])
    closing = b["id"]
    check("the SAME byte-identical output at closing scope is a NEW run —"
          " no comment appended to the command to force it through",
          b.get("existing") is False and closing != passing
          and b["scope"] == "closing", str(b)[:400])
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", green2_log, "--scope", "closing", "--result",
                 "pass", "--mission", M])
    check("and recording that one twice still cites, never duplicates",
          b.get("existing") is True and b["id"] == closing, str(b)[:300])

    print("== --commit: the tree moved before the run could be recorded")
    head = git("rev-parse", "HEAD")
    (TMP / "src.txt").write_text("the toy project\nmoved on\n")
    git("add", "-A")
    git("commit", "-qm", "the tree moves on")
    earlier_log = log("earlier.log", "41 passed, at the earlier commit\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q -m service",
                 "--log", earlier_log, "--result", "pass", "--commit", head,
                 "--mission", M])
    declared = b["id"]
    check("the run binds to the commit it judged, and says the binding is"
          " DECLARED rather than measured",
          b["binding"] == "declared" and b["commit_sha"] == head
          and b["tree_hash"] is None and b["dirty"] is None, str(b)[:400])
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q -m service",
                 "--log", earlier_log, "--result", "pass", "--commit", head,
                 "--mission", M], rc=3)
    check("a declared run is deduplicated on its own terms",
          f"already on the record as run:{declared}" in b.get("reason", ""),
          b.get("reason", "")[:300])

    print("== --expect fail: a red batch is not a green one")
    red_log = log("red.log", "12 failed, 3 passed — as intended\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q -k guard",
                 "--log", red_log, "--result", "fail", "--expect", "fail",
                 "--mission", M])
    red = b["id"]
    check("the row carries expect=fail",
          b["expect"] == "fail" and b["result"] == "fail", str(b)[:300])
    after_log = log("after.log", "15 passed\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q -k guard",
                 "--log", after_log, "--result", "pass", "--mission", M])
    green = b["id"]
    rc, b = seal("DevReport_T1_r1_v01.md", "devreport", key="T1", round=1,
                 version=1, derives=f"artifact:{spec}",
                 summary="the guard, red then green",
                 runs=(f"| run:{red} | python3 -m pytest -q -k guard | 12 failed"
                       f" (expected) |\n"
                       f"| run:{green} | python3 -m pytest -q -k guard |"
                       f" 15 passed |"),
                 noticed="- None", relay="")
    dev = b["artifact"]["id"]
    check("a DevReport may cite both — the fail-before is part of the story",
          rc == 0 and sorted(b["run_cites"]) == sorted([red, green]),
          str(b.get("run_cites")))
    rc, b = seal("Critique_T1_r1_v01.md", "critique", rc=3, key="T1", round=1,
                 version=1, derives=f"artifact:{dev}", verdict="PASS",
                 criteria=f"| 1 | the guard rejects bad input | met |"
                          f" run:{red} | R |",
                 risk="- None", relay="")
    check("but a `met` criterion anchored on it is REFUSED at seal",
          "[expect-fail-anchor]" in b.get("reason", "")
          and "Cite the pass-after run" in b.get("reason", ""),
          b.get("reason", "")[:400])
    rc, b = seal("Critique_T1_r1_v01.md", "critique", key="T1", round=1,
                 version=1, derives=f"artifact:{dev}", verdict="PASS",
                 criteria=(f"| 1 | the guard rejects bad input | met |"
                           f" run:{green} | R |\n"
                           f"| 2 | the guard fails before the fix | met |"
                           f" run:{red} | R |"),
                 risk="- None", relay="")
    check("the pass-after run anchors it, and the fail-before anchors the"
          " criterion that is ABOUT the failure",
          rc == 0 and len(b["evidence"]) == 2, str(b.get("evidence"))[:300])
    rc, b = run(["lint", "--mission", M])
    check("lint agrees — nothing to report",
          rc == 0 and b.get("ok") is True, str(b.get("findings"))[:400])

    print("== run list / run show")
    rc, b = run(["run", "list", "--mission", M])
    ids = [r["id"] for r in b["runs"]]
    check("`run list --mission` reads the table for one mission",
          ids == sorted(ids) and passing in ids and declared in ids
          and silent in ids, str(ids))
    check("and every column a citing seat needs is there",
          {"result", "expect", "binding", "cmd_sha", "git_tree", "scope",
           "tree_hash", "commit_sha", "log_path"} <= set(b["runs"][0]),
          str(sorted(b["runs"][0]))[:400])
    rc, b = run(["run", "show", str(script_run)])
    check("`run show` gives one row in full",
          b["id"] == script_run and b["cmd"] == "ops/verify.sh"
          and b["cmd_sha"] == want_sha and b["recorded_by"] == "constructor:T1",
          str(b)[:400])
    rc, b = run(["run", "show", "99999"], rc=1)
    check("and an unknown id is an error, not an empty row",
          "no run 99999" in (b.get("error") or ""), str(b)[:200])
    rc, b = run(["run", "list"])
    check("`run list` with no mission reads them all",
          len(b["runs"]) >= len(ids), f"{len(b['runs'])} rows")
    rc, b = run(["supersede", f"run:{silent}", "--by", "reality", "--reason",
                 "the resultless row was re-run properly"])
    rc, b = run(["run", "list", "--mission", M])
    check("a superseded run still lists, marked as superseded — history is not"
          " deleted, it stops binding",
          [r["superseded_by"] for r in b["runs"] if r["id"] == silent]
          == ["reality"], str(b["runs"])[:300])

    print("== and it all replays")
    rc, b = run(["rebuild"])
    check("rebuild replays every run, skipping none",
          b.get("ok") is True and not b.get("replay_skips"), str(b)[:300])
    rc, b = run(["run", "show", str(declared)])
    check("the declared binding survives the replay",
          b["binding"] == "declared" and b["commit_sha"] == head
          and b["tree_hash"] is None, str(b)[:300])
    rc, b = run(["run", "show", str(red)])
    check("so does the fail-before mark", b["expect"] == "fail", str(b)[:300])
    rc, b = run(["doctor"])
    check("doctor CLEAN", rc == 0 and b.get("ok") is True,
          str(b.get("findings"))[:400])

    print()
    if FAILS:
        print(f"M7 RUNS: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("M7 RUNS GATE PASSED — a run row now says what it was, what it"
          " judged, whether it passed, whether it was meant to fail, and which"
          " script produced it; and scope is part of its identity")


if __name__ == "__main__":
    main()
