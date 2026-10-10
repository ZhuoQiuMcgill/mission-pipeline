#!/bin/bash
# probe-git-check-readonly.sh (2026-10-09, for design v48; round 22 #1 and #2).
#
# Part 1 (replace objects): `refs/replace/<X>` makes git read object X as Y.
# After admission, a replace ref for the delivered blob makes the landing's
# checkout write different (larger) bytes. Mechanism: every landing git command
# runs with `-c core.useReplaceRefs=false` (the receiver gets it on its command
# line; the hook passes it again on each command).
#
# Part 2 (checks must not write): git's cleanliness checks run the clean filter
# on stat-dirty files. An LFS-style clean stores the content (git-lfs writes the
# object into .git/lfs/objects) before returning a pointer, so a check on a large
# uncommitted LFS file writes that much data even if the landing is then refused.
# Mechanism: during checks the program configures a read-only comparator as the
# clean filter: it hashes stdin and prints the canonical pointer text, writing
# nothing. git-lfs itself is not installed here, so the "writing" control is a
# stand-in that stores content the way git-lfs clean does.
#
# Usage: probe-git-check-readonly.sh <scratch-dir>   (the dir is wiped)
set -u
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@p GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@p
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
P=${1:?scratch dir}
fails=0
die() { echo "SETUP FAILED: $*"; exit 2; }
ok() { echo "  PASS $*"; }
bad() { echo "  FAIL $*"; fails=$((fails+1)); }
[ -d "$P" ] && chmod -R u+w "$P" 2>/dev/null; rm -rf "$P"; mkdir -p "$P/bin" || die mk
cat > "$P/bin/writing-clean" <<'EOF'
#!/bin/sh
store=$1; t=$(mktemp "$store/tmp.XXXXXX"); cat > "$t"; oid=$(sha256sum "$t" | cut -d' ' -f1); size=$(stat -c %s "$t"); mv "$t" "$store/$oid"
printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n' "$oid" "$size"
EOF
cat > "$P/bin/readonly-clean" <<'EOF'
#!/usr/bin/env python3
import hashlib, sys
h = hashlib.sha256(); n = 0
while True:
    b = sys.stdin.buffer.read(1 << 20)
    if not b: break
    h.update(b); n += len(b)
sys.stdout.write('version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n' % (h.hexdigest(), n))
EOF
chmod +x "$P/bin/"* || die chmod

echo "part 1: a replace ref created after admission for the delivered blob"
for cfg in "" "-c core.useReplaceRefs=false"; do
  R=$P/r1; rm -rf "$R"; mkdir -p "$R/hooks"; cd "$R" || exit 2
  git init -q -b main repo && cd repo || die init
  printf 'base\n' > f; git add f && git commit -q -m A || die A; A=$(git rev-parse HEAD)
  X=$(printf 'delivered\n' | git hash-object -w --stdin)
  Y=$(head -c 100000 /dev/zero | tr '\0' 'Y' | git hash-object -w --stdin)
  TI=$R/ti; GIT_INDEX_FILE=$TI git read-tree "$A"; GIT_INDEX_FILE=$TI git update-index --cacheinfo 100644,"$X",f
  B=$(git commit-tree -p "$A" -m B "$(GIT_INDEX_FILE=$TI git write-tree)"); git update-ref refs/mp/deliv "$B"; GD=$(git rev-parse --absolute-git-dir)
  git replace "$X" "$Y" || die replace
  printf '#!/bin/sh\nset -e\ngit %s read-tree -u -m %s "$1"\n' "$cfg" "$A" > "$R/hooks/push-to-checkout"; chmod +x "$R/hooks/push-to-checkout"
  git -c core.hooksPath=/dev/null push --receive-pack="git $cfg -c core.hooksPath=$R/hooks -c receive.denyCurrentBranch=updateInstead receive-pack" "$GD" refs/mp/deliv:refs/heads/main > "$R/out" 2>&1 || die "push failed: $(cat "$R/out")"
  n=$(wc -c < f)
  if [ -z "$cfg" ]; then [ "$n" = 100000 ] && ok "control: replace ref honoured, f written as $n bytes (admission assumed 10)" || bad "control did not reproduce ($n bytes)"
  else [ "$n" = 10 ] && ok "core.useReplaceRefs=false: f written as the delivered blob ($n bytes)" || bad "replace ref still honoured ($n bytes)"; fi
done

echo "part 2: cleanliness check over a large uncommitted change to an LFS-tracked file outside the change set"
for mode in writing readonly; do
  R=$P/r2; rm -rf "$R"; mkdir -p "$R/store"; cd "$R" || exit 2
  git init -q -b main repo && cd repo || die init2
  printf 'g filter=lfs\n' > .gitattributes; printf 'small\n' > g
  git -c filter.lfs.clean="$P/bin/writing-clean $R/store" add .gitattributes g && git commit -q -m A || die A2
  rm -f "$R/store/"*; head -c 5000000 /dev/urandom > g
  if [ $mode = writing ]; then c="$P/bin/writing-clean $R/store"; else c="$P/bin/readonly-clean"; fi
  git -c filter.lfs.clean="$c" update-index -q --refresh; git -c filter.lfs.clean="$c" diff-files --quiet; d=$?
  w=$(du -sb "$R/store" | cut -f1)
  if [ $mode = writing ]; then
    [ $d != 0 ] && [ "$w" -ge 5000000 ] && ok "control: check judged dirty and wrote $w bytes into the object store" || bad "control did not reproduce (dirty=$d, $w bytes)"
  else
    [ $d != 0 ] && [ "$w" = 0 ] && ok "read-only comparator: check judged dirty, 0 bytes written" || bad "dirty=$d, $w bytes"
    printf 'small\n' > g; git -c filter.lfs.clean="$c" update-index -q --refresh; git -c filter.lfs.clean="$c" diff-files --quiet
    [ $? = 0 ] && [ "$(du -sb "$R/store" | cut -f1)" = 0 ] && ok "read-only comparator: restored file judged clean, still 0 bytes written" || bad "restored file not judged clean"
  fi
done

echo "git $(git --version | cut -d' ' -f3); failures: $fails"
[ $fails = 0 ]
