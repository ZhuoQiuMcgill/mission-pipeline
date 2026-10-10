#!/bin/bash
# probe-git-program-lfs-filter.sh (2026-10-09, for design v50; round 24 #3).
#
# Problem: git-lfs smudge, on a cache miss, can fetch the object through any
# configured transfer (including a plain local-directory remote), so network
# isolation does not stop it from writing an extra copy into the LFS cache.
#
# Mechanism under test: the landing never runs git-lfs. Its LFS filter is the
# program's own: smudge reads the pointer, opens .git/lfs/objects/<aa>/<bb>/<oid>
# directly (no transfer, no fallback), streams it while checking size and
# SHA-256, and fails on a missing or mismatching object; clean is the read-only
# comparator from probe-git-check-readonly.sh.
#
# Usage: probe-git-program-lfs-filter.sh <scratch-dir>   (the dir is wiped)
set -u
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@p GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@p
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
P=${1:?scratch dir}
fails=0
die() { echo "SETUP FAILED: $*"; exit 2; }
ok() { echo "  PASS $*"; }
bad() { echo "  FAIL $*"; fails=$((fails+1)); }
rm -rf "$P"; mkdir -p "$P/bin" || die mk
cat > "$P/bin/program-smudge" <<'EOF'
#!/usr/bin/env python3
# Program LFS smudge: local object store only, verified while streaming; never transfers.
import hashlib, os, re, sys
gitdir = sys.argv[1]
ptr = sys.stdin.buffer.read()
if ptr == b'':
    sys.exit(0)
m = re.fullmatch(rb'version https://git-lfs\.github\.com/spec/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n', ptr)
if not m:
    sys.stdout.buffer.write(ptr); sys.exit(0)          # not a pointer: pass through, like git-lfs
oid, size = m.group(1).decode(), int(m.group(2))
path = os.path.join(gitdir, 'lfs', 'objects', oid[0:2], oid[2:4], oid)
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
except OSError as e:
    sys.stderr.write('mp-lfs: object %s missing locally: %s\n' % (oid, e)); sys.exit(1)
h = hashlib.sha256(); n = 0; out = []
with os.fdopen(fd, 'rb') as f:
    while True:
        b = f.read(1 << 20)
        if not b: break
        h.update(b); n += len(b); out.append(b)
if n != size or h.hexdigest() != oid:
    sys.stderr.write('mp-lfs: object %s does not match its pointer\n' % oid); sys.exit(1)
for b in out: sys.stdout.buffer.write(b)
EOF
chmod +x "$P/bin/program-smudge"

setup() {  # repo with an LFS-style pointer for g; object present in .git/lfs/objects; a "local remote" store elsewhere
  R=$P/r; rm -rf "$R"; mkdir -p "$R/remote-store"; cd "$R" || exit 2
  git init -q -b main repo && cd repo || die init
  GD=$(git rev-parse --absolute-git-dir)
  head -c 300000 /dev/urandom > "$R/content"; OID=$(sha256sum "$R/content" | cut -d' ' -f1); SIZE=$(stat -c %s "$R/content")
  mkdir -p "$GD/lfs/objects/${OID:0:2}/${OID:2:2}"; cp "$R/content" "$GD/lfs/objects/${OID:0:2}/${OID:2:2}/$OID"
  cp "$R/content" "$R/remote-store/$OID"          # what a local-directory transfer could copy back from
  printf 'g filter=lfs\n' > .gitattributes
  printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n' "$OID" "$SIZE" > "$R/ptr"
  B=$(git hash-object -w "$R/ptr"); A1=$(git hash-object -w .gitattributes)
  TI=$R/ti; GIT_INDEX_FILE=$TI git update-index --add --cacheinfo 100644,"$A1",.gitattributes
  T0=$(GIT_INDEX_FILE=$TI git write-tree); C0=$(git commit-tree -m base "$T0")
  GIT_INDEX_FILE=$TI git update-index --add --cacheinfo 100644,"$B",g
  T1=$(GIT_INDEX_FILE=$TI git write-tree); C1=$(git commit-tree -p "$C0" -m deliv "$T1")
  git read-tree -u --reset "$C0" || die base-checkout
}
lfsbytes() { du -sb "$GD/lfs" | cut -f1; }
rt() { git -c filter.lfs.smudge="$P/bin/program-smudge $GD" -c filter.lfs.required=true read-tree -u -m "$C0" "$C1" 2> "$R/err"; }

echo "case 1: object present locally"
setup; rt; rc=$?
[ $rc = 0 ] && cmp -s g "$R/content" && ok "g materialized from the local store, verified" || bad "exit $rc: $(cat "$R/err")"

echo "case 2: object removed from the local store after the last check (a local-directory copy still exists)"
setup; rm -f "$GD/lfs/objects/${OID:0:2}/${OID:2:2}/$OID"; before=$(lfsbytes)
rt; rc=$?
[ $rc != 0 ] && grep -q "missing locally" "$R/err" && ok "checkout fails (exit $rc): no transfer, no fallback" || bad "exit $rc: $(cat "$R/err")"
[ "$(lfsbytes)" = "$before" ] && [ ! -e "$GD/lfs/objects/${OID:0:2}/${OID:2:2}/$OID" ] && ok "nothing written under .git/lfs" || bad ".git/lfs changed ($before -> $(lfsbytes))"

echo "case 3: local object corrupted (same length, different bytes)"
setup; head -c "$SIZE" /dev/zero > "$GD/lfs/objects/${OID:0:2}/${OID:2:2}/$OID"
rt; rc=$?
[ $rc != 0 ] && grep -q "does not match" "$R/err" && ok "checkout fails (exit $rc) on a mismatching object" || bad "exit $rc: $(cat "$R/err")"

echo "git $(git --version | cut -d' ' -f3); failures: $fails"
[ $fails = 0 ]
