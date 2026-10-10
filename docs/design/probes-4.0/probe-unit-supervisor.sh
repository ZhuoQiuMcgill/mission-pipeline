#!/usr/bin/env bash
# Exploratory probe (not a gate): the unit supervisor. Each execution unit runs as an
# independent transient systemd *service* (Delegate=yes) whose main process is the
# supervisor. Inside the service's cgroup the supervisor sits in its own leaf "sup";
# the unit subtree "unit" (memory.oom.group=1, own memory.max) holds the host.
# The caller (standing in for the scheduler) does not wait for anything; it only reads
# the proof file afterwards, as a new scheduler generation would read the ledger.
#
# Checks:
#  1. Normal host: the proof carries the host's real exit code (7) and zero OOM counts.
#  2. Host killed by the unit's own limit: the supervisor survives (it is outside the
#     unit subtree), and its proof records signal 9, unit oom >= 1, unit oom_kill >= 1.
#  3. The proof is written only after the unit subtree is empty (populated 0).
# Exits non-zero on any failed check.
set -u
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

SUP='
  proof=$1 host_script=$2
  C=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
  mkdir "$C/sup" "$C/unit"; echo $BASHPID > "$C/sup/cgroup.procs"
  echo "+memory +pids" > "$C/cgroup.subtree_control"
  echo 64M > "$C/unit/memory.max"; echo 0 > "$C/unit/memory.swap.max"; echo 1 > "$C/unit/memory.oom.group"
  bash -c "echo \$BASHPID > $C/unit/cgroup.procs; exec bash $host_script" >/dev/null 2>&1 &
  host=$!; wait $host; st=$?
  while grep -q "populated 1" "$C/unit/cgroup.events"; do sleep 0.1; done
  pop=$(awk "/^populated /{print \$2}" "$C/unit/cgroup.events")
  oom=$(awk "/^oom /{print \$2}" "$C/unit/memory.events.local")
  kill=$(awk "/^oom_kill /{print \$2}" "$C/unit/memory.events")
  printf "STATUS=%s UNIT_OOM=%s UNIT_OOM_KILL=%s POPULATED_AT_PROOF=%s\n" "$st" "$oom" "$kill" "$pop" > "$proof.tmp"
  mv "$proof.tmp" "$proof"
  rmdir "$C/unit"'

run_unit() {  # $1 = proof path, $2 = host command (written to a script file)
  printf '%s\n' "$2" > "$1.host.sh"
  systemd-run --user -q --collect -p Delegate=yes -- bash -c "$SUP" sup "$1" "$1.host.sh"
  for i in $(seq 1 100); do [ -e "$1" ] && break; sleep 0.1; done; }

run_unit "$T/p1" 'sleep 0.5; exit 7'
p1=$(cat "$T/p1" 2>/dev/null); echo "  normal host: $p1"
run_unit "$T/p2" 'sleep 30 & python3 -c "b=bytearray(200*1024*1024)"; echo AFTER'
p2=$(cat "$T/p2" 2>/dev/null); echo "  OOM host:    $p2"

check "normal host: proof has the real exit code and no OOM" '[[ "$p1" == "STATUS=7 UNIT_OOM=0 UNIT_OOM_KILL=0 POPULATED_AT_PROOF=0" ]]'
check "OOM host: supervisor survived and wrote a proof" '[ -n "$p2" ]'
check "OOM host: proof records kill by signal 9 (137) and unit-level OOM" '[[ "$p2" =~ ^STATUS=137\ UNIT_OOM=[1-9][0-9]*\ UNIT_OOM_KILL=[1-9] ]]'
check "proofs written only after the unit subtree was empty" '[[ "$p1" == *"POPULATED_AT_PROOF=0"* && "$p2" == *"POPULATED_AT_PROOF=0"* ]]'
exit $fail
