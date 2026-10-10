#!/usr/bin/env bash
# Exploratory probe (not a gate): can an execution unit be held to a memory cap
# (cgroup v2 via a systemd user scope) and a writable-area size cap (bubblewrap
# tmpfs --size)? Exits non-zero if either cap does not hold.
set -u
fail=0

# 1. Memory. Inside one scope: confirm the scope's own cgroup has memory.max = 64 MiB,
#    a 16 MB allocation succeeds (control), a 200 MB allocation is OOM-killed (137),
#    and the scope's memory.events records at least one oom_kill. A scope that never
#    started, or a python that never ran, cannot produce this output. OOMPolicy=continue
#    keeps systemd from stopping the whole scope on the first OOM kill, so the shell can report.
out=$(systemd-run --user --scope -q -p MemoryMax=64M -p MemorySwapMax=0 -p TasksMax=16 -p OOMPolicy=continue -- sh -c '
  cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
  echo "MAX $(cat "$cg/memory.max")"
  python3 -c "b=bytearray(16*1024*1024); print(\"SMALL_OK\")"
  python3 -c "b=bytearray(200*1024*1024); print(\"ALLOCATED\")"; echo "BIG_RC $?"
  echo "OOMKILL $(awk "/^oom_kill /{print \$2}" "$cg/memory.events")"' 2>&1)
max=$(printf '%s\n' "$out" | awk '/^MAX /{print $2}')
big=$(printf '%s\n' "$out" | awk '/^BIG_RC /{print $2}')
oom=$(printf '%s\n' "$out" | awk '/^OOMKILL /{print $2}')
if [ "$max" = 67108864 ] && printf '%s' "$out" | grep -q SMALL_OK \
   && ! printf '%s' "$out" | grep -q ALLOCATED && [ "$big" = 137 ] && [ "${oom:-0}" -ge 1 ]; then
  echo "PASS memory: scope max=$max, 16 MB ok, 200 MB killed (rc=$big, oom_kill=$oom)"
else
  echo "FAIL memory: max=$max big_rc=$big oom_kill=$oom"; printf '%s\n' "$out"; fail=1
fi

# 1b. Whole unit under systemd's default OOMPolicy=stop. systemd stops the scope
#     ASYNCHRONOUSLY after the kernel's kill, so other processes may run briefly
#     (the shell often still prints AFTER). The sibling's output goes to /dev/null so
#     the command substitution does not wait on it, its natural lifetime is 30 s, and
#     it must be gone within 5 s of systemd-run returning. A negative control with
#     OOMPolicy=continue must leave the sibling alive, so the check cannot pass by the
#     sibling simply exiting on its own. (The synchronous alternative, memory.oom.group,
#     is in probe-oom-group.sh.)
whole_unit() {  # $1 = OOMPolicy; prints "<sibling alive after 5 s: yes|no> <AFTER printed: yes|no>"
  local pidf; pidf=$(mktemp)
  local out; out=$(systemd-run --user --scope -q -p MemoryMax=64M -p MemorySwapMax=0 -p OOMPolicy="$1" -- sh -c '
    sleep 30 >/dev/null 2>&1 & echo $! > "$0"
    python3 -c "b=bytearray(200*1024*1024)"; echo AFTER' "$pidf" 2>&1)
  local sib; sib=$(cat "$pidf"); rm -f "$pidf"
  for i in 1 2 3 4 5; do kill -0 "$sib" 2>/dev/null || break; sleep 1; done
  local alive=no; kill -0 "$sib" 2>/dev/null && alive=yes
  local after=no; printf '%s' "$out" | grep -q AFTER && after=yes
  kill "$sib" 2>/dev/null; echo "$alive $after"; }
read -r stop_alive stop_after <<<"$(whole_unit stop)"
read -r cont_alive cont_after <<<"$(whole_unit continue)"
if [ "$stop_alive" = no ] && [ "$cont_alive" = yes ]; then
  echo "PASS whole unit: OOMPolicy=stop ended the sibling within 5 s; OOMPolicy=continue left it alive (shell printed AFTER under stop: $stop_after)"
else
  echo "FAIL whole unit: stop -> sibling alive=$stop_alive; continue -> sibling alive=$cont_alive"; fail=1
fi

# 2. Disk: in a 1 MiB tmpfs, a 512 KiB write succeeds (control); a 4 MiB write hits
#    ENOSPC and stops at 1 MiB.
out=$(bwrap --ro-bind / / --dev /dev --proc /proc --size 1048576 --tmpfs /tmp -- \
  sh -c 'dd if=/dev/zero of=/tmp/s bs=64k count=8 2>/dev/null && echo SMALL_OK; rm -f /tmp/s
         dd if=/dev/zero of=/tmp/f bs=64k count=64 2>&1; stat -c %s /tmp/f')
size=$(printf '%s\n' "$out" | tail -1)
if printf '%s' "$out" | grep -q SMALL_OK && printf '%s' "$out" | grep -q "No space left" && [ "$size" -le 1048576 ]; then
  echo "PASS disk: tmpfs --size 1 MiB stopped the write at $size bytes"
else
  echo "FAIL disk: write not capped (size=$size)"; fail=1
fi

exit $fail
