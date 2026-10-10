#!/bin/bash
# probe-git-push-to-checkout.sh (2026-10-09, for design v46; round 20 #1).
#
# Problem: with denyCurrentBranch=updateInstead, git's default worktree update
# runs `read-tree -u -m HEAD <new>` from the worktree's HEAD *at that moment*.
# If someone moved the branch (HEAD) since the re-check, the write set is no
# longer base -> delivered, so the disk admission computed for that set does
# not bound it.
#
# Mechanism under test: a program-generated push-to-checkout hook (in the
# program's own read-only hooks directory; repository hooks stay disabled)
# replaces git's default. It refuses unless the worktree's HEAD is exactly the
# recorded base, runs git's own cleanliness checks, then updates with
# `read-tree -u -m <base> <new>`, so the write set is exactly base -> delivered.
#
# Usage: probe-git-push-to-checkout.sh <scratch-dir>   (the dir is wiped)
set -u
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@p GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@p
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
P=${1:?scratch dir}
fails=0
die() { echo "SETUP FAILED: $*"; exit 2; }
ok() { echo "  PASS $*"; }
bad() { echo "  FAIL $*"; fails=$((fails+1)); }

setup() {
  [ -d "$P/hooks" ] && chmod -R u+w "$P/hooks"
  rm -rf "$P" || die "cannot wipe $P"; mkdir -p "$P/hooks"; cd "$P" || exit 2
  git init -q -b main repo || die init; cd repo
  printf 'base\n' > f; printf 'g-base\n' > g; git add f g && git commit -q -m A || die A
  BASE=$(git rev-parse HEAD)
  TI=$P/ti; GIT_INDEX_FILE=$TI git read-tree "$BASE" || die ti
  B=$(printf 'delivered\n' | git hash-object -w --stdin)
  GIT_INDEX_FILE=$TI git update-index --cacheinfo 100644,$B,f || die ti2
  DT=$(GIT_INDEX_FILE=$TI git write-tree); [ "$DT" != "$(git rev-parse "$BASE^{tree}")" ] || die "same tree"
  D=$(git commit-tree -p "$BASE" -m B "$DT") || die ct; git update-ref refs/mp/deliv "$D"
  GD=$(git rev-parse --absolute-git-dir)
  # The hook is generated per landing with the recorded base written into it (no environment dependence).
  cat > "$P/hooks/push-to-checkout" <<HOOK
#!/bin/sh
set -e
base=$BASE
head=\$(git rev-parse --verify HEAD)
[ "\$head" = "\$base" ] || { echo "mp: worktree HEAD \$head is not the recorded base \$base" >&2; exit 1; }
git update-index -q --ignore-submodules --refresh
git diff-files --quiet --ignore-submodules -- || { echo "mp: unstaged changes" >&2; exit 1; }
git diff-index --quiet --cached --ignore-submodules "\$base" -- || { echo "mp: staged changes" >&2; exit 1; }
git read-tree -u -m "\$base" "\$1"
HOOK
  chmod 0555 "$P/hooks/push-to-checkout"; chmod 0555 "$P/hooks"
}
push() {  # $1 = lease value
  env -i PATH=/usr/bin:/bin HOME="$P" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -c core.hooksPath=/dev/null push --receive-pack="git -c core.hooksPath=$P/hooks -c receive.autogc=false -c receive.denyCurrentBranch=updateInstead receive-pack" \
    "$GD" refs/mp/deliv:refs/heads/main --force-with-lease=refs/heads/main:"$1" > "$P/push.out" 2>&1
  echo $?
}
snap() { echo "main=$(git rev-parse main) head=$(git rev-parse HEAD) idx=$(sha256sum < "$GD/index" | cut -c1-12) itree=$(git write-tree) f=$(cat f) g=$(cat g)"; }

echo "case 1: HEAD is the recorded base, clean"
setup; rc=$(push "$BASE")
[ "$rc" = 0 ] && [ "$(git rev-parse main)" = "$D" ] && [ "$(git write-tree)" = "$DT" ] && [ "$(cat f)" = delivered ] && [ "$(cat g)" = g-base ] \
  && ok "landed: main = delivered, index tree = delivered tree, only f changed" || bad "exit $rc: $(snap) :: $(tr '\n' ' ' < "$P/push.out")"

echo "case 2: the branch moved to C (g changed) after the re-check; the lease is made to pass so receive-pack reaches the worktree update"
setup; printf 'g-C\n' > g; git commit -q -am C || die C; C=$(git rev-parse HEAD)
before=$(snap); rc=$(push "$C"); after=$(snap)
[ "$rc" != 0 ] && grep -q "push-to-checkout hook declined" "$P/push.out" && ok "refused by the hook (exit $rc)" || bad "not refused (exit $rc)"
# the hook ran `update-index --refresh` only if it got past the HEAD check; here it must not have, so the index bytes are identical
[ "$before" = "$after" ] && ok "nothing written: main, HEAD, index bytes, files unchanged" || { bad "state changed"; diff <(echo "$before") <(echo "$after"); }

echo "case 3: dirty worktree (unstaged change)"
setup; printf 'local\n' > f; before=$(snap | sed 's/ idx=[^ ]*//'); rc=$(push "$BASE"); after=$(snap | sed 's/ idx=[^ ]*//')
[ "$rc" != 0 ] && [ "$before" = "$after" ] && ok "refused, nothing written apart from the index stat refresh" || bad "exit $rc: $before -> $after"

echo "case 4: staged change"
setup; printf 'staged\n' > g; git add g; before=$(snap | sed 's/ idx=[^ ]*//'); rc=$(push "$BASE"); after=$(snap | sed 's/ idx=[^ ]*//')
[ "$rc" != 0 ] && [ "$before" = "$after" ] && ok "refused, nothing written" || bad "exit $rc: $before -> $after"

echo "git $(git --version | cut -d' ' -f3); failures: $fails"
[ $fails = 0 ]
