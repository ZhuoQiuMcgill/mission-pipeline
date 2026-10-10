#!/usr/bin/env bash
# Exploratory probe (not a gate): two-layer resource scopes with a delegated cgroup.
# The program owns the unit cgroup (systemd user scope, Delegate=yes) and builds the
# layers itself: "ctl" for the supervising shell, "run" for one tool execution with
# its own memory.max and memory.oom.group=1.
#
# Checks:
#  1. With oom.group=1, one OOM in "run" kills every process in "run" together: the
#     shell inside "run" never reaches AFTER, and the sibling is gone at once, not
#     after its natural 30 s lifetime (we check within 5 s).
#  2. Negative control, oom.group=0: the sibling survives the OOM and the shell
#     reaches AFTER, so check 1 is sensitive to the setting.
#  3. Level attribution: the OOM shows up in run/memory.events.local ("oom" and
#     "oom_kill"), while the unit level's own memory.events.local stays at zero, so a
#     run-level overrun is not mistaken for a whole-unit overrun.
# Exits non-zero on any failed check.
set -u
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

trial() {  # $1 = oom.group value; prints: AFTER=<n> SIB_ALIVE=<yes|no> RUN=<...> UNIT=<...>
  systemd-run --user --scope -q -p Delegate=yes -- bash -c '
    group=$1
    cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
    mkdir "$cg/ctl" "$cg/run"
    echo $BASHPID > "$cg/ctl/cgroup.procs"
    echo "+memory +pids" > "$cg/cgroup.subtree_control"
    echo 64M > "$cg/run/memory.max"; echo 0 > "$cg/run/memory.swap.max"; echo "$group" > "$cg/run/memory.oom.group"
    sibf=$(mktemp)
    out=$(bash -c "echo \$BASHPID > \"$cg/run/cgroup.procs\"
                   sleep 30 >/dev/null 2>&1 & echo \$! > $sibf
                   python3 -c \"b=bytearray(200*1024*1024)\"; echo AFTER" 2>/dev/null)
    sib=$(cat "$sibf"); rm -f "$sibf"
    alive=no
    for i in 1 2 3 4 5; do kill -0 "$sib" 2>/dev/null || break; sleep 1; done
    kill -0 "$sib" 2>/dev/null && alive=yes
    printf "AFTER=%s SIB_ALIVE=%s RUN=[%s] UNIT=[%s]\n" \
      "$(printf %s "$out" | grep -c AFTER)" "$alive" \
      "$(grep -E "^(oom|oom_kill) " "$cg/run/memory.events.local" | tr "\n" " ")" \
      "$(grep -E "^(oom|oom_kill) " "$cg/memory.events.local" | tr "\n" " ")"
    kill "$sib" 2>/dev/null; true' bash "$1"; }

g1=$(trial 1); echo "  oom.group=1: $g1"
g0=$(trial 0); echo "  oom.group=0: $g0"
check "oom.group=1: shell in the run group never reached AFTER" '[[ "$g1" == *"AFTER=0"* ]]'
check "oom.group=1: sibling killed together (gone within 5 s)" '[[ "$g1" == *"SIB_ALIVE=no"* ]]'
check "negative control oom.group=0: sibling survived the OOM" '[[ "$g0" == *"SIB_ALIVE=yes"* ]]'
run1=${g1#*RUN=[}; run1=${run1%%]*}
check "attribution: run level recorded oom and oom_kill ($run1)" '[[ "$run1" =~ ^oom\ [1-9][0-9]*\ oom_kill\ [1-9][0-9]*\ $ ]]'
check "attribution: unit level's own counters stayed zero" '[[ "$g1" == *"UNIT=[oom 0 oom_kill 0 ]"* ]]'
exit $fail
