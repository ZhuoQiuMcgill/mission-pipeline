#!/bin/bash
# probe-git-materialization-inputs.sh (2026-10-09, for design v47; round 21 #1).
#
# Problem: the landing hook runs `read-tree -u -m <base> <delivered>`. Fixing the
# two commits does not fix what gets materialized: git also reads (a) the
# worktree/index `.gitattributes`, and (b) the sparse-checkout rules. A change to
# either between the last check and the read-tree changes the bytes written
# (CRLF expansion) or the set of paths written (paths outside the change set).
#
# Mechanism under test:
#   (a) `--attr-source=<delivered>` makes git read attributes from the bound
#       commit only (plus $GIT_DIR/info/attributes, which the view freezes);
#   (b) `-c core.sparseCheckout=false` makes read-tree ignore the sparse rules,
#       so a widened rule set cannot pull extra paths in.
# Each part first reproduces the problem in a control run.
#
# Usage: probe-git-materialization-inputs.sh <scratch-dir>   (the dir is wiped)
set -u
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@p GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@p
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
P=${1:?scratch dir}
fails=0
die() { echo "SETUP FAILED: $*"; exit 2; }
ok() { echo "  PASS $*"; }
bad() { echo "  FAIL $*"; fails=$((fails+1)); }

setup() {  # A: .gitattributes '* -text', f (2 lines), g; B: only f changes (3 lines, LF = 6 bytes)
  rm -rf "$P"; mkdir -p "$P"; cd "$P" || exit 2
  git init -q -b main repo || die init; cd repo
  printf '* -text\n' > .gitattributes; printf 'a\nb\n' > f; printf 'g\n' > g
  git add -A && git commit -q -m A || die A; A=$(git rev-parse HEAD)
  TI=$P/ti; GIT_INDEX_FILE=$TI git read-tree "$A" || die ti
  F=$(printf 'x\ny\nz\n' | git hash-object -w --stdin)
  GIT_INDEX_FILE=$TI git update-index --cacheinfo 100644,"$F",f || die ti2
  B=$(git commit-tree -p "$A" -m B "$(GIT_INDEX_FILE=$TI git write-tree)") || die B
}
stage_crlf_rule() { printf '* -text\nf text eol=crlf\n' > .gitattributes && git add .gitattributes || die stage; }

echo "part a: a staged .gitattributes change (f -> text eol=crlf) before read-tree -u -m A B"
setup; stage_crlf_rule; git read-tree -u -m "$A" "$B" || die rt-a0
n=$(wc -c < f); [ "$n" = 9 ] && ok "control: live attributes used, f materialized as CRLF ($n bytes, admission assumed 6)" || bad "control did not reproduce ($n bytes)"
setup; stage_crlf_rule; git --attr-source="$B" read-tree -u -m "$A" "$B" || die rt-a1
n=$(wc -c < f); [ "$n" = 6 ] && ok "--attr-source=<delivered>: f materialized as LF ($n bytes), matching the admission" || bad "--attr-source did not hold ($n bytes)"
setup; stage_crlf_rule; git -c attr.tree="$B" read-tree -u -m "$A" "$B" || die rt-a2
n=$(wc -c < f); [ "$n" = 6 ] && ok "attr.tree=<delivered> gives the same result ($n bytes)" || bad "attr.tree did not hold ($n bytes)"

echo "part b: sparse rules widened to include g (not reapplied); g has skip-worktree and is absent"
sparse_setup() {
  setup
  git sparse-checkout init --no-cone > /dev/null 2>&1 || die sparse-init
  printf '/f\n/.gitattributes\n' > "$(git rev-parse --git-path info/sparse-checkout)"
  git sparse-checkout reapply > /dev/null 2>&1 || die reapply
  [ ! -e g ] && [ "$(git ls-files -v | grep -c '^S')" = 1 ] || die "sparse precondition"
  printf '/f\n/g\n/.gitattributes\n' > "$(git rev-parse --git-path info/sparse-checkout)"
}
sparse_setup; git read-tree -u -m "$A" "$B" || die rt-b0
[ -e g ] && ok "control: widened rules pulled g (outside the change set) into the worktree" || bad "control did not reproduce"
sparse_setup; git -c core.sparseCheckout=false read-tree -u -m "$A" "$B" || die rt-b1
[ ! -e g ] && [ "$(cat f | head -1)" = x ] && ok "core.sparseCheckout=false: only f written, g stays absent" || bad "g present=$([ -e g ] && echo yes || echo no)"

echo "git $(git --version | cut -d' ' -f3); failures: $fails"
[ $fails = 0 ]
