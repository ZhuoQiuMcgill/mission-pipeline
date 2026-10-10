#!/bin/bash
# probe-git-refuse-mode.sh (v2, 2026-10-09; v1 was criticised in round 18 #4:
# the delivered tree equalled the base tree, the index was never checked, and
# exit statuses were filtered away).
#
# Claim under test (design 6.6, zero occupancy): with
# receive.denyCurrentBranch=refuse, a push to the target branch is refused,
# writing no ref, index, file or operation state, whenever ANY worktree has the
# target branch checked out (main worktree, linked worktree) or a rebase/bisect
# in progress names it; with no occupant, only the ref moves.
#
# Usage: probe-git-refuse-mode.sh <scratch-dir>   (the dir is wiped)
set -u
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@p GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@p
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
P=${1:?scratch dir}; rm -rf "$P"; mkdir -p "$P"; cd "$P" || exit 2
fails=0
die() { echo "SETUP FAILED: $*"; exit 2; }
ok() { echo "  PASS $*"; }
bad() { echo "  FAIL $*"; fails=$((fails+1)); }

git init -q -b main repo || die init
cd repo
printf 'base\n' > f; printf 'keep\n' > g; git add f g && git commit -q -m base || die base
BASE=$(git rev-parse HEAD)
# delivered commit: f changes content, a new file h; built from a temp index so the
# real index is untouched, and asserted to differ from the base tree.
TI=$P/tmp-index; cp .git/index "$TI"
printf 'delivered\n' > "$P/f.new"; B1=$(git hash-object -w "$P/f.new"); B2=$(printf 'new\n' | git hash-object -w --stdin)
GIT_INDEX_FILE=$TI git update-index --cacheinfo 100644,$B1,f --add --cacheinfo 100644,$B2,h || die tmpindex
DT=$(GIT_INDEX_FILE=$TI git write-tree) || die write-tree
[ "$DT" != "$(git rev-parse $BASE^{tree})" ] || die "delivered tree equals base tree"
D=$(git commit-tree -p $BASE -m deliv $DT) || die commit-tree
git update-ref refs/mp/deliv $D || die update-ref
git switch -q -c feature || die feature
git worktree add -q ../wt1 main || die wt1
GD=$(git rev-parse --absolute-git-dir)

# Snapshot of everything a landing could touch: target ref, every worktree's HEAD
# (symbolic and resolved), index bytes, ls-files -s, tracked file bytes, op state.
snap() {
  {
    echo "ref $(git rev-parse refs/heads/main)"
    for w in "$P/repo" "$P/wt1"; do
      echo "== $w"
      echo "head $(git -C "$w" symbolic-ref -q HEAD || echo detached) $(git -C "$w" rev-parse HEAD)"
      gd=$(git -C "$w" rev-parse --absolute-git-dir)
      echo "index $(sha256sum < "$gd/index" | cut -c1-16)"
      git -C "$w" ls-files -s | sha256sum | cut -c1-16 | sed 's/^/lsfiles /'
      for f in f g h; do [ -e "$w/$f" ] && echo "file $f $(sha256sum < "$w/$f" | cut -c1-16)" || echo "file $f absent"; done
      for s in rebase-merge rebase-apply BISECT_START BISECT_LOG; do
        [ -e "$gd/$s" ] && echo "op $s $(find "$gd/$s" -type f -exec cat {} + 2>/dev/null | sha256sum | cut -c1-16)"
      done
    done
  }
}
push() {
  git -c core.hooksPath=/dev/null push --receive-pack="git -c core.hooksPath=/dev/null -c receive.autogc=false -c receive.denyCurrentBranch=refuse receive-pack" \
    "$GD" refs/mp/deliv:refs/heads/main --force-with-lease=refs/heads/main:"$1" > "$P/push.out" 2>&1
  echo $?
}
expect_refused() {  # $1 label, $2 lease value
  local before after rc
  before=$(snap); rc=$(push "$2"); after=$(snap)
  if [ "$rc" != 0 ] && grep -q "branch is currently checked out" "$P/push.out"; then ok "$1: refused (exit $rc)"; else bad "$1: not refused (exit $rc): $(tr '\n' ' ' < "$P/push.out")"; fi
  if [ "$before" = "$after" ]; then ok "$1: ref, HEADs, index bytes, files, op state unchanged"; else bad "$1: state changed"; diff <(echo "$before") <(echo "$after") | sed 's/^/      /'; fi
}

echo "case 1: main checked out in linked worktree wt1"
expect_refused "linked worktree" "$BASE"

echo "case 2: main checked out in the main worktree"
git -C ../wt1 switch -q --detach || die detach1
git switch -q main || die switch-main
expect_refused "main worktree" "$BASE"
git switch -q feature || die back-feature

echo "case 3: bisect in progress in wt1, started from main"
git -C ../wt1 switch -q main || die wt1-main
git -C ../wt1 bisect start > /dev/null 2>&1 || die bisect-start
git -C ../wt1 bisect bad HEAD > /dev/null 2>&1 || die bisect-bad
git -C ../wt1 switch -q --detach || die bisect-detach
echo "  wt1 HEAD: $(git -C ../wt1 symbolic-ref -q HEAD || echo detached); BISECT_START=$(cat "$GD/worktrees/wt1/BISECT_START")"
expect_refused "bisect in progress" "$BASE"
git -C ../wt1 bisect reset > /dev/null 2>&1 || die bisect-reset

echo "case 4: rebase in progress in wt1 on main (stopped at a conflict)"
git -C ../wt1 switch -q main 2>/dev/null; git -C ../wt1 switch -q -c side "$BASE" || die side
printf 'side\n' > ../wt1/f; git -C ../wt1 commit -q -am side || die side-commit
git -C ../wt1 switch -q main || die wt1-main2
printf 'mainwork\n' > ../wt1/f; git -C ../wt1 commit -q -am mainwork || die mainwork
MW=$(git rev-parse refs/heads/main)
git -C ../wt1 rebase -q side > /dev/null 2>&1 && die "rebase did not stop"
echo "  wt1 HEAD: $(git -C ../wt1 symbolic-ref -q HEAD || echo detached); head-name=$(cat "$GD/worktrees/wt1/rebase-merge/head-name")"
expect_refused "rebase in progress" "$MW"
git -C ../wt1 rebase --abort > /dev/null 2>&1 || die rebase-abort

echo "case 5 (positive control): no worktree has main checked out"
git -C ../wt1 switch -q --detach || die detach5
before=$(snap); rc=$(push "$MW"); after=$(snap)
[ "$rc" = 0 ] && [ "$(git rev-parse refs/heads/main)" = "$D" ] && ok "unoccupied: push accepted, main = delivered" || bad "unoccupied: exit $rc, main=$(git rev-parse refs/heads/main): $(tr '\n' ' ' < "$P/push.out")"
if [ "$(echo "$before" | grep -v '^ref ')" = "$(echo "$after" | grep -v '^ref ')" ]; then ok "unoccupied: only the ref moved (HEADs, index bytes, files unchanged)"; else bad "unoccupied: worktree state changed"; diff <(echo "$before") <(echo "$after") | sed 's/^/      /'; fi

echo "git $(git --version | cut -d' ' -f3); failures: $fails"
[ $fails = 0 ]
