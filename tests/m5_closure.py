#!/usr/bin/env python3
"""M5 gate — THE TWO CLOSURE MODES, by documents only (new at v1.2.0).

    a mission is claimed by sealing its Charter v1 and closed by sealing its
    MissionClose note — and no `mission claim`, `mission close` or `gate close`
    command is ever issued.

The field stalled for hours at a mission boundary with everything prepared and
nothing blocking on substance: the harness's permission classifier refused
`mp mission claim`, `mp mission close` and `mp gate close` — three plain
commands, no reason beyond "blocked by classifier" — while `seal`, `run record`,
`wave open` and `supersede` had run for days without a prompt. The lifecycle
verbs read like governance acts. So there are no lifecycle verbs any more.

  Week05-SignOff   the default. The MissionClose note is REFUSED without the
                   principal's verbatim words; with them the mission closes, and
                   `mp acts` gains nothing — the principal was in the room. Every
                   substantive stop still bites: an undisposed flag, a lint
                   finding on a v1.1 seal, a closing run whose tree drifted, a
                   required Closure Audit that is missing, and an expect-fail run
                   cited on a `met` row.
  Week06-Auto      continuous delegation. `mp config set closure auto` on the
                   principal's word; the note is REFUSED without `## Delegation`,
                   REFUSED naming a retired contract, and closes under a live
                   one — and THAT close is an act in the principal's name, which
                   they repudiate afterwards: `mp supersede mission:<M> --by
                   principal` reopens the mission and retires the note.

Run: python3 tests/m5_closure.py
"""
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

S = "Week05-SignOff"
A = "Week06-Auto"
FAILS = []
ENV = {}
TMP = None

# the three the classifier refused, and the ceremony they belonged to
LIFECYCLE_ACTIONS = {"mission.claim", "mission.close", "gate.check"}


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
              f"got rc={r.returncode} out={r.stdout.strip()[:400]}"
              f" err={r.stderr.strip()[:300]}")
    return r.returncode, body


def led(mission, fname):
    return f".claude/mission-pipeline/ledger/{mission}/{fname}"


def doc(mission, fname, kind, **kw):
    kw.setdefault("mission", mission)
    fixture(TMP, led(mission, fname), kind, **kw)
    return led(mission, fname)


def seal(mission, fname, kind, rc=0, **kw):
    return run(["seal", doc(mission, fname, kind, **kw)], rc=rc)


def journal():
    return [json.loads(x) for x in
            (TMP / ".claude" / "mission-pipeline" / "ledger" / "events.jsonl")
            .read_text(encoding="utf-8").splitlines() if x.strip()]


def db_rows(sql, params=()):
    con = sqlite3.connect(str(TMP / ".claude" / "mission-pipeline" / "ledger"
                              / "mp.db"))
    rows = con.execute(sql, params).fetchall()
    con.close()
    return rows


def commit(g, msg):
    g("add", "-A")
    g("commit", "-qm", msg)


def prepare(g, mission, goal, flag_text, task="T1"):
    """A minimal lawful mission: Charter (the claim), a wave, a spec, a run, a
    report carrying one flag, a critique, and an Integration Note that disposes
    the flag and closes the wave."""
    rc, b = seal(mission, "Charter_v01.md", "charter", version=1,
                 derives="none", extra_header=f"branch: mission/{mission}",
                 goal=goal, prohibitions="- never weaken the closing gate\n"
                                         "- never close on an undisposed flag",
                 amendments="| v1 | 2026-09-05 | (initial seal) | — |")
    charter = b["artifact"]["id"]
    contracts = [c["id"] for c in b["contracts"]]
    run(["wave", "open", "W1", "--mission", mission, "--tasks", task])
    rc, b = seal(mission, f"TaskSpec_{task}_v01.md", "taskspec", key=task,
                 version=1, wave="W1", recovers="", touches="no",
                 derives=f"artifact:{charter}", objective=goal,
                 ac1="the suite is green", out_of_scope="- the retry path")
    spec = b["artifact"]["id"]
    log = TMP / f"{mission}-suite.log"
    log.write_text(f"{mission}: 2 suites green\n")
    commit(g, f"work for {mission}")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q",
                 "--log", log.name, "--result", "pass", "--mission", mission])
    rid = b["id"]
    rc, b = seal(mission, f"DevReport_{task}_r1_v01.md", "devreport", key=task,
                 round=1, version=1, derives=f"artifact:{spec}",
                 summary="built", noticed=f"- {flag_text}", relay="",
                 runs=f"| run:{rid} | python3 -m pytest -q | 2 suites green |")
    dev, flag = b["artifact"]["id"], b["flags"][0]["id"]
    rc, b = seal(mission, f"Critique_{task}_r1_v01.md", "critique", key=task,
                 round=1, version=1, derives=f"artifact:{dev}", verdict="PASS",
                 criteria=f"| 1 | the suite is green | met | run:{rid} | R |",
                 risk="- None", relay="")
    crit = b["artifact"]["id"]
    return {"charter": charter, "contracts": contracts, "spec": spec,
            "dev": dev, "crit": crit, "flag": flag, "run": rid}


def dispose(mission, ctx, note_version=1):
    rc, b = seal(mission, f"IntegrationNote_W1_v{note_version:02d}.md",
                 "integrationnote", version=note_version, wave="W1",
                 derives=f"artifact:{ctx['crit']}",
                 regrounding="wave 1 delivers what the Charter asked for",
                 flags=(f"| {ctx['flag']} | {ctx['flag_text']} |"
                        f" artifact:{ctx['dev']} | accepted risk — it lands in"
                        f" the next mission |"),
                 compaction="no", relay="")
    return b["artifact"]["id"]


# ---------------------------------------------------------------- the gate

def main():
    global TMP, ENV
    TMP = Path(tempfile.mkdtemp(prefix="mp-m5-"))
    ENV = dict(os.environ, MP_ROOT=str(TMP), MP_ACTOR="pm")
    g = lambda *a: subprocess.run(["git", "-C", str(TMP)] + list(a),
                                  capture_output=True, text=True)
    g("init", "-q")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (TMP / "src.txt").write_text("the toy project\n")
    g("add", "-A")
    g("commit", "-qm", "init")

    print("== defaults: the conservative reading, until the principal speaks")
    run(["init"])
    rc, b = run(["config", "get"])
    check("closure is sign-off and audit is off out of the box",
          b["config"] == {"closure": "sign-off", "audit": "off"}
          and all(s["source"] == "default" for s in b["settings"]),
          str(b)[:300])
    mpjson = json.loads((TMP / ".claude" / "mission-pipeline"
                         / "mp.json").read_text(encoding="utf-8"))
    check("and they are mirrored into mp.json, where a human can read them",
          mpjson.get("config") == {"closure": "sign-off", "audit": "off"},
          str(mpjson))

    print("== the Charter IS the claim")
    before = {m[0] for m in db_rows("SELECT name FROM missions")}
    ctx = prepare(g, S, "a loader that never lies",
                  "the retry path is untested")
    ctx["flag_text"] = "the retry path is untested"
    after = db_rows("SELECT name, branch, round_cap, status FROM missions")
    check("sealing the Charter v1 claimed the mission with its header's branch",
          (S, f"mission/{S}", 3, "open") in after and S not in before,
          str(after))
    fixture(TMP, led(S, "TaskSpec_T9_v01.md"), "taskspec",
            mission="Week99-NeverClaimed", key="T9", version=1, wave="W1",
            recovers="", touches="no", derives="none", objective="x",
            ac1="y", out_of_scope="- z")
    rc, b = run(["seal", led(S, "TaskSpec_T9_v01.md")], rc=3)
    check("a document for a mission nobody chartered is REFUSED, and told how",
          "unknown mission 'Week99-NeverClaimed'" in b.get("reason", "")
          and "Charter v1" in b.get("reason", ""), b.get("reason", "")[:300])

    print("== `mp gate close` is retired")
    rc, b = run(["gate", "close", "--mission", S], rc=3)
    check("it always REFUSES, and names the document to write instead",
          b.get("refused") is True and "retired" in b.get("reason", "")
          and "MissionClose" in b.get("reason", "")
          and "## Closing run" in b.get("reason", ""), b.get("reason", "")[:400])

    print("== sign-off: every substantive stop still bites")

    def close_note(mission, rc=0, version=1, **kw):
        kw.setdefault("derives", "none")
        return seal(mission, f"MissionClose_v{version:02d}.md", "missionclose",
                    rc=rc, version=version, **kw)

    rc, b = close_note(S, rc=3, closing_run="- None",
                       acceptance="> close it")
    check("the undisposed flag blocks the close (invariant 11)",
          "flags-disposed" in b.get("reason", "")
          and str(ctx["flag"]) in b.get("reason", ""), b.get("reason", "")[:400])
    note = dispose(S, ctx)
    rc, b = close_note(S, rc=3, closing_run="- None", acceptance="> close it")
    check("with the flags disposed, the missing closing run is what remains",
          "closing-run" in b.get("reason", "")
          and "flags-disposed" not in b.get("reason", ""),
          b.get("reason", "")[:400])

    # a lint finding on a v1.1+ seal — the only kind that may block a close
    intact = (TMP / led(S, "DevReport_T1_r1_v01.md")).read_text(encoding="utf-8")
    (TMP / led(S, "DevReport_T1_r1_v01.md")).write_text(
        intact.replace("## Runs", "## Was runs", 1), encoding="utf-8")
    rc, b = run(["lint", "--mission", S], rc=2)
    check("breaking a sealed v1.1 document is a lint finding",
          any(f["rule"] == "seal-parse" for f in b.get("findings", [])),
          str(b.get("findings"))[:300])
    rc, b = close_note(S, rc=3, closing_run="- None", acceptance="> close it")
    check("and a lint finding on THIS mission blocks its close",
          "lint-clean" in b.get("reason", "")
          and "seal-parse" in b.get("reason", ""), b.get("reason", "")[:500])
    (TMP / led(S, "DevReport_T1_r1_v01.md")).write_text(intact, encoding="utf-8")

    (TMP / "closing.log").write_text("all suites green, full scope\n")
    commit(g, "the integrated result")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q --full",
                 "--log", "closing.log", "--scope", "closing",
                 "--mission", S, "--result", "pass"])
    closing = b["id"]
    check("the closing run binds to the tree it judged",
          b["scope"] == "closing" and b["binding"] == "measured"
          and b["git_tree"], str(b)[:300])

    rc, b = close_note(S, rc=3, closing_run=f"run:{ctx['run']}",
                       acceptance="> close it")
    check("a task-scope run is not a closing gate",
          "scope 'task'" in b.get("reason", ""), b.get("reason", "")[:400])

    (TMP / "src.txt").write_text("the toy project\nand a quiet change after\n")
    rc, b = close_note(S, rc=3, closing_run=f"run:{closing}",
                       acceptance="> close it")
    check("source drift after the closing run fails the close CLOSED",
          "source drifted since the closing gate ran — fail closed"
          in b.get("reason", ""), b.get("reason", "")[:400])
    (TMP / "src.txt").write_text("the toy project\n")

    rc, b = close_note(S, rc=3, closing_run=f"run:{closing}")
    check("and without the principal's own words, sign-off mode REFUSES",
          "principal-acceptance" in b.get("reason", "")
          and "Principal's acceptance" in b.get("reason", "")
          and "closure auto" in b.get("reason", ""), b.get("reason", "")[:500])

    print("== sign-off: the audit switch, on the principal's word")
    rc, b = run(["config", "set", "audit", "on", "--quote",
                 "I want the Auditor's read on every close from here"])
    check("`mp config set audit on` is recorded", b.get("ok") is True)
    rc, b = close_note(S, rc=3, closing_run=f"run:{closing}",
                       acceptance="> yes — close it")
    check("with the audit on, a close with no ClosureAudit is REFUSED",
          "closure-audit" in b.get("reason", "")
          and "ClosureAudit" in b.get("reason", ""), b.get("reason", "")[:400])
    rc, b = seal(S, "ClosureAudit_v01.md", "closureaudit", version=1,
                 derives=f"artifact:{note}",
                 read="the Charter, the delivery set, the flag ledger",
                 findings="- the delivery matches the Charter's first priority")
    audit = b["artifact"]["id"]
    rc, b = close_note(S, rc=3, closing_run=f"run:{closing}",
                       audit=f"artifact:{ctx['dev']}",
                       acceptance="> yes — close it")
    check("and a `## Closure audit` pointing at something else is REFUSED",
          "is not a live sealed ClosureAudit" in b.get("reason", ""),
          b.get("reason", "")[:400])

    print("== an expect-fail run is never a passing anchor")
    (TMP / "red.log").write_text("12 failed, as intended\n")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q -k guard",
                 "--log", "red.log", "--result", "fail", "--expect", "fail",
                 "--mission", S])
    red = b["id"]
    check("a fail-before batch is recorded as one",
          b["expect"] == "fail" and b["result"] == "fail", str(b)[:250])
    rc, b = seal(S, "Critique_T1_r2_v01.md", "critique", rc=3, key="T1",
                 round=2, version=1, derives=f"artifact:{ctx['dev']}",
                 verdict="PASS", risk="- None", relay="",
                 criteria=f"| 1 | the guard rejects bad input | met |"
                          f" run:{red} | R |")
    check("a `met` criterion anchored on it is REFUSED at the door",
          "[expect-fail-anchor]" in b.get("reason", "")
          and "pass-after run" in b.get("reason", ""), b.get("reason", "")[:400])
    rc, b = seal(S, "Critique_T1_r2_v01.md", "critique", key="T1", round=2,
                 version=1, derives=f"artifact:{ctx['dev']}",
                 verdict="CHANGES-REQUESTED", risk="- None", relay="",
                 criteria=f"| 1 | the guard fails before the fix | met |"
                          f" run:{red} | R |")
    check("unless the criterion IS the fail-before, and says so",
          rc == 0 and len(b["evidence"]) == 1, str(b.get("evidence"))[:300])

    print("== sign-off: the close itself")
    rc, b = close_note(S, closing_run=f"run:{closing}",
                       audit=f"artifact:{audit}",
                       acceptance="> yes — this is what I asked for. Close it.",
                       outcome_text="the loader never lies, and the retry path"
                                    " is carried into the next mission")
    mc = b.get("mission_close") or {}
    close_art = b["artifact"]["id"]
    check("the note seals and the mission closes",
          rc == 0 and mc.get("closed_in") == close_art
          and mc.get("mode") == "sign-off" and mc.get("audit") == audit,
          str(mc)[:400])
    check("every closing check is on the record, one by one",
          [c["check"] for c in mc.get("checks", [])]
          == ["charter-sealed", "flags-disposed", "closing-run",
              "source-unchanged", "lint-clean", "closure-audit",
              "principal-acceptance"]
          and all(c["ok"] for c in mc["checks"]), str(mc.get("checks"))[:500])
    check("the registry says closed, and names the note that closed it",
          db_rows("SELECT status, closed_in, closed_mode FROM missions"
                  " WHERE name=?", (S,)) == [("closed", close_art, "sign-off")],
          str(db_rows("SELECT status, closed_in, closed_mode FROM missions"
                      " WHERE name=?", (S,))))
    rc, b = close_note(S, rc=3, version=2, closing_run=f"run:{closing}",
                       audit=f"artifact:{audit}", acceptance="> again")
    check("a second close is REFUSED — and says how to reopen instead",
          "already closed" in b.get("reason", "")
          and f"mp supersede mission:{S}" in b.get("reason", ""),
          b.get("reason", "")[:400])

    rc, b = run(["acts", "--mission", S])
    kinds = [a["kind"] for a in b["acts"]]
    check("in sign-off mode the close adds NOTHING to the acts list —"
          " the principal was in the room",
          "mission-closed" not in kinds, str(kinds))
    check("but the config declaration is there, in the principal's own words",
          any(a["kind"] == "config-set" and a["ref"] == "config:audit"
              and "Auditor's read" in a["words"] for a in b["acts"]),
          str([a for a in b["acts"] if a["kind"] == "config-set"])[:400])

    print("== auto: continuous delegation, on the principal's word")
    rc, b = run(["config", "set", "audit", "off", "--quote",
                 "the audit was for that mission; drop it again"])
    rc, b = run(["config", "set", "closure", "auto", "--quote",
                 "you close them; I will repudiate what I disagree with"])
    check("`mp config set closure auto` is recorded", b.get("ok") is True)
    rc, b = run(["config", "get", "closure"])
    check("and it is what `config get` reports",
          b["value"] == "auto" and b["source"] == "set", str(b))

    ctx2 = prepare(g, A, "a scheduler that never double-books",
                   "the clock skew case is unmeasured")
    ctx2["flag_text"] = "the clock skew case is unmeasured"
    dispose(A, ctx2)
    (TMP / "closing-auto.log").write_text("all suites green, full scope, auto\n")
    commit(g, "the integrated result for auto")
    rc, b = run(["run", "record", "--cmd", "python3 -m pytest -q --full",
                 "--log", "closing-auto.log", "--scope", "closing",
                 "--mission", A, "--result", "pass"])
    closing2 = b["id"]

    rc, b = close_note(A, rc=3, closing_run=f"run:{closing2}",
                       acceptance="> yes, close it")
    check("in auto mode the principal's words are not what closes a mission —"
          " the note is REFUSED without `## Delegation`",
          "delegation" in b.get("reason", "")
          and "contract:<id>" in b.get("reason", ""), b.get("reason", "")[:400])
    retired = ctx2["contracts"][1]
    run(["supersede", f"contract:{retired}", "--by", "principal", "--reason",
         "that prohibition is superseded by the new Charter"])
    rc, b = close_note(A, rc=3, closing_run=f"run:{closing2}",
                       delegation=f"contract:{retired}")
    check("a RETIRED contract delegates nothing",
          "was retired at" in b.get("reason", "")
          and "delegates nothing" in b.get("reason", ""),
          b.get("reason", "")[:400])
    rc, b = close_note(A, rc=3, closing_run=f"run:{closing2}",
                       delegation="contract:9999")
    check("and a contract that never existed is REFUSED by number",
          "there is no standing contract 9999" in b.get("reason", ""),
          b.get("reason", "")[:400])

    live = ctx2["contracts"][0]
    rc, b = close_note(A, closing_run=f"run:{closing2}",
                       delegation=f"contract:{live}",
                       # the shipped template's audit-off wording, verbatim
                       audit="- not enabled.",
                       outcome_text="the scheduler holds under skew; the"
                                    " unmeasured case is carried forward")
    mc = b.get("mission_close") or {}
    close_art2 = b["artifact"]["id"]
    check("under a LIVE contract the PM closes the mission itself",
          rc == 0 and mc.get("mode") == "auto"
          and mc.get("under") == f"contract:{live}", str(mc)[:400])
    check("and the substantive checks are exactly the same ones",
          [c["check"] for c in mc.get("checks", [])]
          == ["charter-sealed", "flags-disposed", "closing-run",
              "source-unchanged", "lint-clean", "delegation"]
          and all(c["ok"] for c in mc["checks"]), str(mc.get("checks"))[:500])

    rc, b = run(["acts", "--mission", A])
    closed_acts = [a for a in b["acts"] if a["kind"] == "mission-closed"]
    check("THIS close is an act in the principal's name, and says how to"
          " repudiate it",
          len(closed_acts) == 1
          and closed_acts[0]["ref"] == f"artifact:{close_art2}"
          and f"mp supersede mission:{A}" in closed_acts[0]["text"],
          str(closed_acts)[:400])

    print("== the repudiation: item by item, afterwards")
    rc, b = run(["supersede", f"mission:{A}", "--by", "principal", "--reason",
                 "no — the skew case is not something I accept carrying"])
    check("`mp supersede mission:<name> --by principal` is accepted",
          b.get("ok") is True, str(b)[:300])
    check("the mission is open again",
          db_rows("SELECT status, closed_at, closed_in FROM missions"
                  " WHERE name=?", (A,)) == [("open", None, None)],
          str(db_rows("SELECT status, closed_at, closed_in FROM missions"
                      " WHERE name=?", (A,))))
    check("and the MissionClose note is retired with it",
          db_rows("SELECT superseded_by FROM artifacts WHERE id=?",
                  (close_art2,)) == [("principal",)],
          str(db_rows("SELECT superseded_by FROM artifacts WHERE id=?",
                      (close_art2,))))
    rc, b = run(["acts", "--mission", A])
    rep = [a for a in b["acts"] if a["kind"] == "principal-supersession"
           and a["ref"] == f"mission:{A}"]
    check("the repudiation itself is on the acts list, in their words",
          len(rep) == 1 and "not something I accept" in rep[0]["words"]
          and "open again" in rep[0]["text"], str(rep)[:400])
    rc, b = run(["wave", "open", "W2", "--mission", A, "--tasks", "T2"])
    check("a reopened mission takes work again — every rule applies as before",
          b.get("ok") is True, str(b)[:300])
    rc, b = close_note(A, rc=3, closing_run=f"run:{closing2}",
                       delegation=f"contract:{live}")
    check("the repudiated note is still history: re-sealing v1 is REFUSED, and"
          " the next close is a new VERSION of it",
          "[immutability]" in b.get("reason", "")
          and "bump `version:` to 2" in b.get("reason", ""),
          b.get("reason", "")[:400])
    rc, b = run(["worklist", "--mission", A])
    check("and the repudiation leaves a worklist item, not an error",
          rc == 0 and b["owner"] == "pm", str(b)[:300])

    print("== the journal: no lifecycle command was ever issued")
    jl = journal()
    lifecycle = [e for e in jl if e["action"] in LIFECYCLE_ACTIONS]
    check("not one `mission.claim`, `mission.close` or `gate.check` event"
          " exists — the claim and the close rode `artifact.sealed` payloads",
          lifecycle == [], str([e["action"] for e in lifecycle]))
    retired_calls = [e for e in jl if e["action"] == "gate.close"]
    check("the one `gate close` attempt is journaled REFUSED, with the fix",
          len(retired_calls) == 1
          and retired_calls[0]["result"] == "REFUSED"
          and "MissionClose" in retired_calls[0]["reason"],
          str(retired_calls)[:300])
    claims = [e for e in jl if e["result"] == "OK"
              and e["action"] == "artifact.sealed"
              and (e["payload"].get("mission_claim") or {}).get("name")]
    closes = [e for e in jl if e["result"] == "OK"
              and e["action"] == "artifact.sealed"
              and e["payload"].get("mission_close")]
    check("both claims and both closes rode a seal, and nothing else",
          sorted(e["payload"]["mission_claim"]["name"] for e in claims)
          == [S, A] and sorted(e["payload"]["mission_close"]["name"]
                               for e in closes) == [S, A],
          f"{len(claims)} claims, {len(closes)} closes")

    print("== and the whole thing replays")
    rc, b = run(["rebuild"])
    check("rebuild replays every event, skipping none",
          b.get("ok") is True and not b.get("replay_skips"), str(b)[:400])
    rc, b = run(["doctor"])
    check("doctor CLEAN after replaying two closures and a repudiation",
          rc == 0 and b.get("ok") is True, str(b.get("findings"))[:400])
    check("the replayed DB agrees: one closed, one reopened",
          sorted(db_rows("SELECT name, status FROM missions"))
          == [(S, "closed"), (A, "open")],
          str(db_rows("SELECT name, status FROM missions")))
    rc, b = run(["config", "get"])
    check("and the deployment's declarations survived the replay",
          b["config"] == {"closure": "auto", "audit": "off"}, str(b)[:300])

    print("== `mp init --closure auto --audit on` sets them at setup")
    other = Path(tempfile.mkdtemp(prefix="mp-m5b-"))
    env2 = dict(os.environ, MP_ROOT=str(other), MP_ACTOR="pm")
    subprocess.run(["git", "-C", str(other), "init", "-q"],
                   capture_output=True, text=True)
    r = subprocess.run(
        [sys.executable, MP, "--json", "init", "--closure", "auto",
         "--audit", "on", "--quote", "close them yourself; audit every one"],
        capture_output=True, text=True, env=env2)
    check("init accepts the declarations", r.returncode == 0, r.stdout[:300])
    r = subprocess.run([sys.executable, MP, "--json", "config", "get"],
                       capture_output=True, text=True, env=env2)
    got = json.loads(r.stdout.strip().splitlines()[-1])
    check("and a fresh ledger starts in auto mode with the audit on",
          got["config"] == {"closure": "auto", "audit": "on"}
          and all(s["source"] == "set" for s in got["settings"]), r.stdout[:400])
    jl2 = [json.loads(x) for x in
           (other / ".claude" / "mission-pipeline" / "ledger" / "events.jsonl")
           .read_text(encoding="utf-8").splitlines() if x.strip()]
    check("both declarations are journaled with the principal's words",
          [e["action"] for e in jl2] == ["init", "config.set", "config.set"]
          and all(e["payload"]["quote"] == "close them yourself; audit every one"
                  for e in jl2[1:]), str([e["action"] for e in jl2]))

    print()
    if FAILS:
        print(f"M5 CLOSURE: {len(FAILS)} FAILURE(S): {FAILS}")
        sys.exit(1)
    print("M5 CLOSURE GATE PASSED — two closure modes, both driven by"
          " documents: sign-off closes on the principal's own words, auto"
          " closes under a live standing contract and hands the decision back"
          " through `mp acts`, and a repudiation reopens the mission")


if __name__ == "__main__":
    main()
