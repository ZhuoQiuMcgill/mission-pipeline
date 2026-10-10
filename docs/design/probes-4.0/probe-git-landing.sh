#!/usr/bin/env bash
# Exploratory probe (not a gate): land a delivery commit B onto a named branch
# with `git push . B:refs/heads/<target>` under receive.denyCurrentBranch=updateInstead
# and a lease on the expected old value A. Checks that the push always moves the
# named branch (never "whatever is checked out"), updates a clean checkout of it,
# refuses a dirty checkout or a stale lease, is not subverted by repository hooks,
# and that a post-landing check flags the receive-side race's end state.
# Exits non-zero on any failed check.
set -u
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git init -q -b main "$T/r" && cd "$T/r"
git config user.email p@example.invalid && git config user.name probe
echo one > f.txt && git add f.txt && git commit -qm A
A=$(git rev-parse HEAD)
git branch feature
B=$(git commit-tree -p "$A" -m B "$(printf '100644 blob %s\tf.txt\n' "$(echo two | git hash-object -w --stdin)" | git mktree)")
git update-ref refs/mission-pipeline/delivered/m1/op1 "$B"

# `git -c ...` does not reach the receiving side of a local push (its environment is
# reset), so the settings are passed through --receive-pack. Hooks are disabled on
# both sides: a repository's own push-to-checkout hook would otherwise replace the
# built-in worktree update (case 7).
RP='git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c receive.denyCurrentBranch=updateInstead receive-pack'
land() { git -c core.hooksPath=/dev/null push -q --receive-pack="$RP" . \
  "refs/mission-pipeline/delivered/m1/op1:refs/heads/main" \
  --force-with-lease="refs/heads/main:$1" >/dev/null 2>&1; }

# 1. main checked out here, worktree dirty on the file B changes: refused, nothing moves.
echo local-edit > f.txt
land "$A"; rc=$?
check "dirty checkout refused" '[ $rc -ne 0 ] && [ "$(git rev-parse main)" = "$A" ] && [ "$(cat f.txt)" = local-edit ]'
git checkout -q -- f.txt

# 2. User switched this worktree to feature after "we looked": main moves, feature does not.
git switch -q feature
land "$A"; rc=$?
check "named branch moved, checked-out feature untouched" \
  '[ $rc -eq 0 ] && [ "$(git rev-parse main)" = "$B" ] && [ "$(git rev-parse feature)" = "$A" ] && [ "$(cat f.txt)" = one ] && [ -z "$(git status --porcelain)" ]'

# 3. Stale lease: main is now B, a second delivery C still leases A: refused.
C=$(git commit-tree -p "$A" -m C "$(printf '100644 blob %s\tf.txt\n' "$(echo three | git hash-object -w --stdin)" | git mktree)")
git update-ref refs/mission-pipeline/delivered/m1/op1 "$C"
land "$A"; rc=$?
check "stale lease refused" '[ $rc -ne 0 ] && [ "$(git rev-parse main)" = "$B" ]'
git update-ref refs/mission-pipeline/delivered/m1/op1 "$B"

# 4. main checked out and clean: push updates branch, index and files together.
git update-ref refs/heads/main "$A" "$B"
git switch -q main
land "$A"; rc=$?
check "clean checkout updated in place" \
  '[ $rc -eq 0 ] && [ "$(git rev-parse HEAD)" = "$B" ] && [ "$(cat f.txt)" = two ] && [ -z "$(git status --porcelain)" ]'

# 5. main checked out in a linked worktree (clean): that worktree is updated too.
git update-ref refs/heads/main "$A" "$B"; git reset -q --hard "$A"
git switch -q feature
git worktree add -q "$T/w2" main
land "$A"; rc=$?
check "clean linked worktree updated in place" \
  '[ $rc -eq 0 ] && [ "$(git -C "$T/w2" rev-parse HEAD)" = "$B" ] && [ "$(cat "$T/w2/f.txt")" = two ] && [ -z "$(git -C "$T/w2" status --porcelain)" ]'

# 6. main checked out, tracked files clean, but an untracked file sits where the
#    delivery adds a file: refused, the untracked file survives.
git -C "$T/w2" update-ref refs/heads/main "$A" "$B"
git -C "$T/w2" reset -q --hard "$A"
D=$(git commit-tree -p "$A" -m D "$(printf '100644 blob %s\tf.txt\n100644 blob %s\tnew.txt\n' \
  "$(echo one | git hash-object -w --stdin)" "$(echo theirs | git hash-object -w --stdin)" | git mktree)")
git update-ref refs/mission-pipeline/delivered/m1/op1 "$D"
echo mine > "$T/w2/new.txt"
land "$A"; rc=$?
check "untracked file in the way refused" \
  '[ $rc -ne 0 ] && [ "$(git rev-parse main)" = "$A" ] && [ "$(cat "$T/w2/new.txt")" = mine ]'

# 7. A repository hook that "succeeds" without updating the worktree. Without the
#    hooks override it leaves main moved but index and files stale (shown first, as
#    the hazard); with land()'s override the built-in update still happens.
git -C "$T/w2" checkout -q -- . 2>/dev/null; rm -f "$T/w2/new.txt"
git update-ref refs/mission-pipeline/delivered/m1/op1 "$B"
mkdir -p .git/hooks && printf '#!/bin/sh\nexit 0\n' > .git/hooks/push-to-checkout && chmod +x .git/hooks/push-to-checkout
git push -q --receive-pack='git -c receive.denyCurrentBranch=updateInstead receive-pack' . \
  "refs/mission-pipeline/delivered/m1/op1:refs/heads/main" --force-with-lease="refs/heads/main:$A" >/dev/null 2>&1
check "hazard reproduced: hook leaves branch moved but files stale" \
  '[ "$(git -C "$T/w2" rev-parse HEAD)" = "$B" ] && [ "$(cat "$T/w2/f.txt")" = one ]'
git -C "$T/w2" update-ref refs/heads/main "$A" "$B"; git -C "$T/w2" reset -q --hard "$A"
land "$A"; rc=$?
check "with hooks disabled the worktree is updated despite the hook" \
  '[ $rc -eq 0 ] && [ "$(git -C "$T/w2" rev-parse HEAD)" = "$B" ] && [ "$(cat "$T/w2/f.txt")" = two ] && [ -z "$(git -C "$T/w2" status --porcelain)" ]'
rm -f .git/hooks/push-to-checkout

# 8. Post-landing check. Recreate the end state of the receive-side race (the
#    worktree switched to feature between git's "where is main checked out" and its
#    worktree update): HEAD on feature, index and files at B. The check must flag it,
#    and must pass a correctly landed checkout.
landing_damage() {  # $1 = delivery commit; prints worktrees left inconsistent
  git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r w; do
    head_tree=$(git -C "$w" rev-parse "HEAD^{tree}"); idx_tree=$(git -C "$w" write-tree)
    if [ "$(git -C "$w" symbolic-ref -q HEAD)" = refs/heads/main ]; then
      [ "$(git -C "$w" rev-parse HEAD)" = "$1" ] && [ "$idx_tree" = "$head_tree" ] && git -C "$w" diff-files --quiet || echo "$w"
    else
      [ "$idx_tree" = "$(git rev-parse "$1^{tree}")" ] && [ "$head_tree" != "$idx_tree" ] && echo "$w"
    fi
  done; }
check "post-landing check passes a correct landing" '[ -z "$(landing_damage "$B")" ]'
git -C "$T/w2" switch -q --detach "$A"; git -C "$T/w2" switch -q feature 2>/dev/null || git -C "$T/w2" switch -q -c feature2 "$A"
git -C "$T/w2" read-tree -u -m HEAD "$B"
check "post-landing check flags the race end state" '[ "$(landing_damage "$B")" = "$T/w2" ]'

exit $fail
