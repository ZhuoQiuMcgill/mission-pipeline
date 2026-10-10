#!/usr/bin/env bash
# Exploratory probe (not a gate): which OOM counters tell "this execution unit was
# killed by an OOM" apart from "a limit at this level was hit". Hierarchy inside a
# delegated systemd user scope:
#
#   scope/ctl                 the probe shell (cgroup v2: no processes in inner nodes)
#   scope/pool                an ancestor of the unit, memory.max set in case A
#   scope/pool/unit           the execution unit, memory.oom.group=1
#   scope/pool/unit/ctl       the unit's "control" process (stands in for the seat host)
#   scope/pool/unit/run       the allocating process
#
# Case A, ancestor OOM: pool limit 96M, unit limit 1G. The unit's own limit is never
#   hit, so unit/memory.events.local "oom" stays 0; but the unit WAS killed, which the
#   unit's hierarchical memory.events "oom_kill" shows. An acceptance rule that only
#   checks the unit's local "oom" would wrongly accept this attempt.
# Case B, unit-level OOM: unit limit 64M with oom.group=1. unit local "oom" >= 1 and
#   the control process dies too (the whole unit is killed, not only the allocator).
# Exits non-zero on any failed check.
set -u
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

trial() {  # $1 = pool memory.max, $2 = unit memory.max
  systemd-run --user --scope -q -p Delegate=yes -- bash -c '
    pool_max=$1 unit_max=$2
    S=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
    mkdir "$S/ctl" "$S/pool"; echo $BASHPID > "$S/ctl/cgroup.procs"
    echo "+memory +pids" > "$S/cgroup.subtree_control"
    mkdir "$S/pool/unit"; echo "+memory +pids" > "$S/pool/cgroup.subtree_control"
    mkdir "$S/pool/unit/ctl" "$S/pool/unit/run"; echo "+memory +pids" > "$S/pool/unit/cgroup.subtree_control"
    echo "$pool_max" > "$S/pool/memory.max"; echo 0 > "$S/pool/memory.swap.max"
    echo "$unit_max" > "$S/pool/unit/memory.max"; echo 0 > "$S/pool/unit/memory.swap.max"
    echo 1 > "$S/pool/unit/memory.oom.group"
    # control process: a long sleep placed in unit/ctl
    bash -c "echo \$BASHPID > $S/pool/unit/ctl/cgroup.procs; exec sleep 30" >/dev/null 2>&1 &
    ctlpid=$!
    sleep 0.3
    bash -c "echo \$BASHPID > $S/pool/unit/run/cgroup.procs; exec python3 -c \"b=bytearray(200*1024*1024)\"" >/dev/null 2>&1
    for i in 1 2 3 4 5; do kill -0 $ctlpid 2>/dev/null || break; sleep 1; done
    ctl_alive=no; kill -0 $ctlpid 2>/dev/null && ctl_alive=yes
    loc=$(awk "/^oom /{print \$2}" "$S/pool/unit/memory.events.local")
    hier=$(awk "/^oom_kill /{print \$2}" "$S/pool/unit/memory.events")
    pool_loc=$(awk "/^oom /{print \$2}" "$S/pool/memory.events.local")
    echo "UNIT_LOCAL_OOM=$loc UNIT_HIER_OOM_KILL=$hier POOL_LOCAL_OOM=$pool_loc CTL_ALIVE=$ctl_alive"
    kill $ctlpid 2>/dev/null; true' bash "$1" "$2"; }

A=$(trial 96M 1G); echo "  case A (ancestor limit): $A"
B=$(trial max 64M); echo "  case B (unit limit):     $B"
check "A: unit's own limit not hit (local oom = 0)" '[[ "$A" == *"UNIT_LOCAL_OOM=0 "* ]]'
check "A: ancestor's limit hit (pool local oom >= 1)" '[[ "$A" =~ POOL_LOCAL_OOM=[1-9] ]]'
check "A: unit was nevertheless killed (hierarchical oom_kill >= 1)" '[[ "$A" =~ UNIT_HIER_OOM_KILL=[1-9] ]]'
check "A: oom.group killed the unit's control process too" '[[ "$A" == *"CTL_ALIVE=no"* ]]'
check "B: unit's own limit hit (local oom >= 1)" '[[ "$B" =~ UNIT_LOCAL_OOM=[1-9] ]]'
check "B: whole unit killed, control process included" '[[ "$B" == *"CTL_ALIVE=no"* ]]'
exit $fail
