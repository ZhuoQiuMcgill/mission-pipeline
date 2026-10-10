#!/usr/bin/env bash
# Exploratory probe (not a gate): give an execution unit a hard disk cap without
# root by mounting a preallocated, fixed-size ext4 image through fuse2fs (FUSE).
# Checks: the image's host-disk footprint is fixed at creation; writes stop with
# ENOSPC at the image size, including writes through an unlinked-but-open file
# and from inside a bubblewrap sandbox; the inode count is capped. Exits non-zero on any failed check.
# Usage: probe-disk-image-cap.sh <path to fuse2fs binary>
set -u
FUSE2FS=${1:?path to fuse2fs}
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

T=$(mktemp -d); M="$T/mnt"; mkdir "$M"
cleanup() { fusermount3 -u "$M" 2>/dev/null; rm -rf "$T"; }; trap cleanup EXIT

truncate -s 16M "$T/unit.img"
mkfs.ext4 -q -F -N 64 -m 0 -E nodiscard "$T/unit.img"
# mkfs leaves holes; allocating after it reserves all 16 MiB on the host up front.
fallocate -l 16M "$T/unit.img"
before=$(du -k "$T/unit.img" | cut -f1)
check "space reserved up front (${before}k of 16384k)" '[ "$before" -ge 16384 ]'
"$FUSE2FS" -o fakeroot "$T/unit.img" "$M" || { echo "FAIL mount"; exit 1; }
check "mounted" 'mountpoint -q "$M"'

# 1. Plain writes stop at the image size.
dd if=/dev/zero of="$M/big" bs=1M count=64 2>"$T/dd1.err"
check "plain write capped with ENOSPC" 'grep -q "No space left" "$T/dd1.err"'
rm -f "$M/big"; sync

# 2. Writes through an unlinked-but-open file are capped too.
( exec 3>"$M/ghost"; rm "$M/ghost"; dd if=/dev/zero bs=1M count=64 >&3 2>"$T/dd2.err" )
check "unlinked open file capped with ENOSPC" 'grep -q "No space left" "$T/dd2.err"'

# 3. Inode count is capped.
n=0; while [ $n -lt 200 ] && : 2>/dev/null >"$M/f$n"; do n=$((n+1)); done
check "inode count capped (created $n of 200)" '[ $n -lt 200 ]'

# 4. The mount works inside the unit's bubblewrap sandbox, and the cap holds there.
rm -f "$M"/f*; sync
bwrap --ro-bind / / --dev /dev --proc /proc --bind "$M" "$M" -- \
  sh -c 'echo inside > "$0/ok" && dd if=/dev/zero of="$0/big" bs=1M count=64' "$M" 2>"$T/dd3.err"
check "cap holds inside the sandbox" '[ "$(cat "$M/ok")" = inside ] && grep -q "No space left" "$T/dd3.err"'

# 5. Hazard for export: a sparse file's logical length is not bounded by the image.
#    Exporting by copying would materialize it, so export must be metered by
#    logical length (design 7.1). This check records the hazard, it is not a cap.
rm -f "$M/big" "$M/ok"; sync
truncate -s 1G "$M/sparse" 2>/dev/null
check "hazard recorded: 1 GiB sparse file fits in a 16 MiB image" '[ "$(stat -c %s "$M/sparse")" -eq 1073741824 ]'
rm -f "$M/sparse"

# 6. The image never grows on the host disk.
after=$(du -k "$T/unit.img" | cut -f1)
check "host footprint never exceeds the image (${after}k)" '[ "$after" -le 16384 ]'

exit $fail
