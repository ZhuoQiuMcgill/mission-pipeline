#!/bin/bash
# probe-git-history-and-fetch.sh (2026-10-09, for design v49; round 23 #1, #2).
#
# Part 1 (grafts): `info/grafts` rewrites how git reads parent edges without
# changing any commit object. `core.useReplaceRefs=false` does not turn it off,
# so "does the target contain the delivered commit?" can answer yes when the raw
# history says no. Mechanism: ancestry queries run with GIT_GRAFT_FILE=/dev/null
# (plus useReplaceRefs=false and commitGraph=false).
#
# Part 2 (lazy fetch): in a partial clone, reading a missing blob makes git fetch
# it from the promisor remote and write a pack into the repository, even when the
# command is a "read". Mechanism: GIT_NO_LAZY_FETCH=1 turns the read into an
# error with no write.
#
# Usage: probe-git-history-and-fetch.sh <scratch-dir>   (the dir is wiped)
set -u
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@p GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@p
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
P=${1:?scratch dir}
fails=0
die() { echo "SETUP FAILED: $*"; exit 2; }
ok() { echo "  PASS $*"; }
bad() { echo "  FAIL $*"; fails=$((fails+1)); }
rm -rf "$P"; mkdir -p "$P"; cd "$P" || exit 2

echo "part 1: B and C both branch from A; C does not contain B; info/grafts claims C's parent is B"
git init -q -b main g && cd g || die init
git commit -q --allow-empty -m A || die A; A=$(git rev-parse HEAD); T=$(git rev-parse "HEAD^{tree}")
B=$(git commit-tree -p "$A" -m B "$T"); C=$(git commit-tree -p "$A" -m C "$T")
[ "$(git cat-file -p "$C" | sed -n 's/^parent //p')" = "$A" ] || die "raw parent"
echo "$C $B" > .git/info/grafts
git -c advice.graftFileDeprecated=false -c core.useReplaceRefs=false merge-base --is-ancestor "$B" "$C" 2>/dev/null
[ $? = 0 ] && ok "control: with useReplaceRefs=false alone, grafts make B look contained in C" || bad "control did not reproduce"
GIT_GRAFT_FILE=/dev/null git -c core.useReplaceRefs=false -c core.commitGraph=false merge-base --is-ancestor "$B" "$C" 2>/dev/null
rc=$?; [ $rc = 1 ] && ok "GIT_GRAFT_FILE=/dev/null: raw history used, B is not contained in C (exit 1)" || bad "unexpected exit $rc"
cd "$P"

echo "part 2: partial clone (blob:none) from a local repository; read a blob that is not present locally"
git init -q -b main src && cd src || die src
git config uploadpack.allowFilter true; git config uploadpack.allowAnySHA1InWant true
head -c 200000 /dev/urandom > big; git add big && git commit -q -m big || die big; BIG=$(git rev-parse HEAD:big)
cd "$P"; git clone -q --no-checkout --filter=blob:none "file://$P/src" pc || die clone; cd pc
packs() { find .git/objects -type f | wc -l; }
GIT_NO_LAZY_FETCH=1 git cat-file -e "$BIG" 2>/dev/null && die "blob already present"   # even -e would lazily fetch without the variable
n0=$(packs); GIT_NO_LAZY_FETCH=1 git cat-file -p "$BIG" > /dev/null 2>&1; rc=$?; n1=$(packs)
[ $rc != 0 ] && [ "$n0" = "$n1" ] && ok "GIT_NO_LAZY_FETCH=1: read fails (exit $rc), object files unchanged ($n0)" || bad "exit $rc, object files $n0 -> $n1"
n0=$(packs); git cat-file -p "$BIG" > /dev/null 2>&1; rc=$?; n1=$(packs)
[ $rc = 0 ] && [ "$n1" -gt "$n0" ] && ok "control: a plain read fetched the blob and wrote object files ($n0 -> $n1)" || bad "control did not reproduce (exit $rc, $n0 -> $n1)"

echo "git $(git --version | cut -d' ' -f3); failures: $fails"
[ $fails = 0 ]
