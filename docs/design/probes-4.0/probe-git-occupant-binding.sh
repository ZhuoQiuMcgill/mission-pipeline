#!/bin/bash
# probe-git-occupant-binding.sh (v2, 2026-10-09, for design v45; rounds 18 #1 and 19 #1).
#
# Problem: after the pre-push re-check found exactly one occupant (admitted and
# approved), other worktrees can take the target branch with ordinary git
# commands (switch, or a bisect/rebase that leaves HEAD detached but still names
# the branch). A receiver running denyCurrentBranch=updateInstead then updates
# that worktree, which was never admitted or approved.
#
# Mechanism under test: the receiver runs in a mount namespace where only the
# approved worktree can be selected:
#   - the common `worktrees/` dir is a tmpfs holding only the approved worktree's
#     admin dir (every other linked worktree, with its HEAD and operation state,
#     is invisible); when the approved occupant is the main worktree, it holds none;
#   - when the approved occupant is a linked worktree, the receiver also runs with
#     core.bare=true, so the main worktree is never a checkout candidate, whatever
#     its HEAD, BISECT_START or rebase state says.
# Expected: the receiver updates only the approved worktree; if that one no
# longer has the branch, only the ref moves and no worktree is written.
#
# Usage: probe-git-occupant-binding.sh <scratch-dir>   (the dir is wiped)
set -u
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@p GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@p
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
P=${1:?scratch dir}
fails=0
die() { echo "SETUP FAILED: $*"; exit 2; }
ok() { echo "  PASS $*"; }
bad() { echo "  FAIL $*"; fails=$((fails+1)); }

setup() {  # $1 = main|bare. Main worktree W0 (absent when bare), W1 on main, W2 on topic.
  rm -rf "$P"; mkdir -p "$P"; cd "$P" || exit 2
  if [ "$1" = bare ]; then
    git init -q -b main seed || die seed; (cd seed && printf 'base\n' > f && git add f && git commit -q -m base) || die seed-commit
    git clone -q --bare seed repo.git || die bare; cd repo.git; GD=$(pwd); W0=""
  else
    git init -q -b main repo || die init; cd repo
    printf 'base\n' > f; git add f && git commit -q -m base || die base
    GD=$(git rev-parse --absolute-git-dir); W0=$(pwd)
  fi
  BASE=$(git rev-parse main)
  TI=$P/ti; GIT_INDEX_FILE=$TI git read-tree "$BASE" || die ti-read
  B=$(printf 'delivered\n' | git hash-object -w --stdin)
  GIT_INDEX_FILE=$TI git update-index --cacheinfo 100644,$B,f || die ti
  DT=$(GIT_INDEX_FILE=$TI git write-tree) || die write-tree
  [ "$DT" != "$(git rev-parse "$BASE^{tree}")" ] || die "delivered tree equals base tree"
  D=$(git commit-tree -p "$BASE" -m deliv "$DT") || die ct
  git update-ref refs/mp/deliv "$D" || die ur
  git branch -q topic "$BASE" || die topic
  [ -n "$W0" ] && { git switch -q --detach || die w0-detach; }
  git worktree add -q "$P/w1" main || die w1
  git worktree add -q "$P/w2" topic || die w2
}
# Index tree read straight from a worktree's index file, independent of HEAD.
idx_tree() { GIT_DIR=$GD GIT_INDEX_FILE=$1 git write-tree 2>/dev/null || echo unreadable; }
w0_index() { echo "$GD/index"; }
state() {  # $1 = worktree root, $2 = its index file
  echo "$(git -C "$1" symbolic-ref -q HEAD || echo detached) idxtree=$(idx_tree "$2" | cut -c1-12) f=$(cat "$1/f")"
}
push() {  # $1 = approved admin dir name ("" when the approved occupant is the main worktree), $2 = "plain" to skip the namespace
  local recv="git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c receive.autogc=false"
  local args=(--bind / / --dev /dev --proc /proc --tmpfs "$GD/worktrees")
  if [ -n "$1" ]; then args+=(--bind "$GD/worktrees/$1" "$GD/worktrees/$1"); recv="$recv -c core.bare=true"; fi
  recv="$recv -c receive.denyCurrentBranch=updateInstead receive-pack"
  if [ "${2:-}" = plain ]; then
    git -c core.hooksPath=/dev/null push --receive-pack="git -c core.hooksPath=/dev/null -c receive.autogc=false -c receive.denyCurrentBranch=updateInstead receive-pack" \
      "$GD" refs/mp/deliv:refs/heads/main --force-with-lease=refs/heads/main:"$BASE" > "$P/push.out" 2>&1
  else
    bwrap "${args[@]}" -- git -c core.hooksPath=/dev/null push --receive-pack="$recv" \
      "$GD" refs/mp/deliv:refs/heads/main --force-with-lease=refs/heads/main:"$BASE" > "$P/push.out" 2>&1
  fi
  echo $?
}
landed() { [ "$(git -C "$GD" rev-parse main)" = "$D" ]; }

echo "case 0 (control, no namespace): W1 approved, then W1 detaches and W2 switches to main"
setup main
git -C "$P/w1" switch -q --detach && git -C "$P/w2" switch -q main || die race0
b=$(state "$P/w2" "$GD/worktrees/w2/index"); rc=$(push w1 plain); a=$(state "$P/w2" "$GD/worktrees/w2/index")
[ "$b" != "$a" ] && ok "attack reproduced: plain receiver wrote unapproved W2 ($b -> $a)" || bad "control did not reproduce (exit $rc)"

echo "case 0b (control, namespace without core.bare): main worktree takes the branch via bisect state"
setup main
git -C "$P/w1" switch -q --detach && git -C "$W0" switch -q main && git -C "$W0" bisect start > /dev/null 2>&1 && git -C "$W0" switch -q --detach 2>/dev/null || die race0b
b=$(state "$W0" "$GD/index")
bwrap --bind / / --dev /dev --proc /proc --tmpfs "$GD/worktrees" --bind "$GD/worktrees/w1" "$GD/worktrees/w1" -- \
  git -c core.hooksPath=/dev/null push --receive-pack="git -c core.hooksPath=/dev/null -c receive.autogc=false -c receive.denyCurrentBranch=updateInstead receive-pack" \
  "$GD" refs/mp/deliv:refs/heads/main --force-with-lease=refs/heads/main:"$BASE" > "$P/push.out" 2>&1
a=$(state "$W0" "$GD/index")
[ "$b" != "$a" ] && ok "round-19 attack reproduced: W0 (detached, BISECT_START=main) written ($b -> $a)" || bad "control 0b did not reproduce"

echo "case 1: W1 approved; W1 detaches, W2 switches to main"
setup main
git -C "$P/w1" switch -q --detach && git -C "$P/w2" switch -q main || die race1
b0=$(state "$W0" "$GD/index"); b1=$(state "$P/w1" "$GD/worktrees/w1/index"); b2=$(state "$P/w2" "$GD/worktrees/w2/index"); rc=$(push w1)
[ "$rc" = 0 ] && landed && ok "push accepted, main = delivered (ref only)" || bad "exit $rc: $(tr '\n' ' ' < "$P/push.out")"
[ "$b0" = "$(state "$W0" "$GD/index")" ] && [ "$b1" = "$(state "$P/w1" "$GD/worktrees/w1/index")" ] && [ "$b2" = "$(state "$P/w2" "$GD/worktrees/w2/index")" ] \
  && ok "no worktree written; W2 left as 'branch advanced, files stale': $(state "$P/w2" "$GD/worktrees/w2/index")" || bad "a worktree changed"

echo "case 2: W1 approved; W1 detaches, main worktree W0 switches to main"
setup main
git -C "$P/w1" switch -q --detach && git -C "$W0" switch -q main || die race2
b0=$(state "$W0" "$GD/index"); rc=$(push w1)
[ "$rc" = 0 ] && [ "$b0" = "$(state "$W0" "$GD/index")" ] && ok "W0 not written (exit $rc): $(state "$W0" "$GD/index")" || bad "exit $rc, W0 $b0 -> $(state "$W0" "$GD/index")"

echo "case 3: W1 approved; W1 detaches, W0 (detached) checks out main, starts bisect, detaches again"
setup main
git -C "$P/w1" switch -q --detach && git -C "$W0" switch -q main && git -C "$W0" bisect start > /dev/null 2>&1 && git -C "$W0" switch -q --detach 2>/dev/null || die race3
echo "  W0 HEAD=$(git -C "$W0" symbolic-ref -q HEAD || echo detached) BISECT_START=$(cat "$GD/BISECT_START")"
b0=$(state "$W0" "$GD/index"); rc=$(push w1)
[ "$rc" = 0 ] && [ "$b0" = "$(state "$W0" "$GD/index")" ] && ok "W0 with bisect state not written (exit $rc)" || bad "exit $rc, W0 $b0 -> $(state "$W0" "$GD/index")"

echo "case 4: W1 approved; W2 takes the branch via a rebase stopped on a conflict"
setup main
git -C "$P/w1" switch -q --detach || die r4a
git -C "$P/w2" switch -q -c side "$BASE" && printf 'side\n' > "$P/w2/f" && git -C "$P/w2" commit -q -am side || die r4b
git -C "$P/w2" switch -q main && printf 'w2main\n' > "$P/w2/f" && git -C "$P/w2" commit -q -am w2main || die r4c
NEWBASE=$(git -C "$GD" rev-parse main)
git -C "$P/w2" rebase -q side > /dev/null 2>&1 && die "rebase did not stop"
b2=$(state "$P/w2" "$GD/worktrees/w2/index")
bwrap --bind / / --dev /dev --proc /proc --tmpfs "$GD/worktrees" --bind "$GD/worktrees/w1" "$GD/worktrees/w1" -- \
  git -c core.hooksPath=/dev/null push --receive-pack="git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c receive.autogc=false -c core.bare=true -c receive.denyCurrentBranch=updateInstead receive-pack" \
  "$GD" refs/mp/deliv:refs/heads/main --force-with-lease=refs/heads/main:"$NEWBASE" > "$P/push.out" 2>&1; rc=$?
[ "$b2" = "$(state "$P/w2" "$GD/worktrees/w2/index")" ] && [ -f "$GD/worktrees/w2/rebase-merge/head-name" ] && ok "W2 (rebase in progress) not written, rebase state intact (push exit $rc)" || bad "W2 changed: $b2 -> $(state "$P/w2" "$GD/worktrees/w2/index")"
git -C "$P/w2" rebase --abort > /dev/null 2>&1

echo "case 5: no race, approved W1 still on main"
setup main
b0=$(state "$W0" "$GD/index"); b2=$(state "$P/w2" "$GD/worktrees/w2/index"); rc=$(push w1)
[ "$rc" = 0 ] && landed && [ "$(idx_tree "$GD/worktrees/w1/index")" = "$DT" ] && [ "$(cat "$P/w1/f")" = delivered ] \
  && ok "W1 updated: index tree equals the delivered tree, file = delivered" || bad "exit $rc, W1 $(state "$P/w1" "$GD/worktrees/w1/index")"
[ "$b0" = "$(state "$W0" "$GD/index")" ] && [ "$b2" = "$(state "$P/w2" "$GD/worktrees/w2/index")" ] && ok "W0, W2 untouched" || bad "W0/W2 changed"

echo "case 6: approved occupant is the main worktree; W0 detaches, linked W1 switches to main"
setup main
git -C "$P/w1" switch -q --detach && git -C "$W0" switch -q main || die s6
git -C "$W0" switch -q --detach && git -C "$P/w1" switch -q main || die race6
b1=$(state "$P/w1" "$GD/worktrees/w1/index"); rc=$(push "")
[ "$rc" = 0 ] && [ "$b1" = "$(state "$P/w1" "$GD/worktrees/w1/index")" ] && ok "hidden W1 not written (exit $rc)" || bad "exit $rc, W1 $b1 -> $(state "$P/w1" "$GD/worktrees/w1/index")"

echo "case 7: approved occupant is the main worktree, no race"
setup main
git -C "$P/w1" switch -q --detach && git -C "$W0" switch -q main || die s7
rc=$(push "")
[ "$rc" = 0 ] && landed && [ "$(idx_tree "$GD/index")" = "$DT" ] && [ "$(cat "$W0/f")" = delivered ] && ok "W0 updated: index tree equals the delivered tree" || bad "exit $rc, W0 $(state "$W0" "$GD/index")"

echo "case 8: bare common repository; W1 approved; W1 detaches, W2 switches to main"
setup bare
git -C "$P/w1" switch -q --detach && git -C "$P/w2" switch -q main || die race8
b2=$(state "$P/w2" "$GD/worktrees/w2/index"); rc=$(push w1)
[ "$rc" = 0 ] && landed && [ "$b2" = "$(state "$P/w2" "$GD/worktrees/w2/index")" ] && ok "bare layout: ref only, W2 not written" || bad "exit $rc, W2 $b2 -> $(state "$P/w2" "$GD/worktrees/w2/index")"

echo "case 9: bare common repository, no race"
setup bare
rc=$(push w1)
[ "$rc" = 0 ] && landed && [ "$(idx_tree "$GD/worktrees/w1/index")" = "$DT" ] && ok "bare layout: W1 updated, index tree equals the delivered tree" || bad "exit $rc, W1 $(state "$P/w1" "$GD/worktrees/w1/index")"

echo "git $(git --version | cut -d' ' -f3), bwrap $(bwrap --version | cut -d' ' -f2); failures: $fails"
[ $fails = 0 ]
